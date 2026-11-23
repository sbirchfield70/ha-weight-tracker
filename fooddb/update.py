#!/usr/bin/env python3
"""Food DB loader: Open Food Facts (US) + USDA FoodData Central.

  update.py full    rebuild everything into a new file, then swap it in
  update.py nightly OFF delta files since last run; full rebuild if the DB
                    is missing, it is Sunday, or USDA published a new release
"""
import csv, datetime, gzip, io, json, os, re, shutil, sqlite3, sys, time, urllib.request, zipfile

BASE = "/opt/fooddb"
DB = f"{BASE}/fooddb.sqlite"
WORK = f"{BASE}/work"
OFF_CSV = "https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz"
OFF_DELTA = "https://static.openfoodfacts.org/data/delta/"
FDC_PAGE = "https://fdc.nal.usda.gov/download-datasets"
FDC_BASE = "https://fdc.nal.usda.gov/fdc-datasets/"
UA = {"User-Agent": "ha-weight-tracker-fooddb/1.0 (+https://github.com/sbirchfield70/ha-weight-tracker)"}

NUT_KEYS = ["kcal", "protein", "carbs", "fat", "sat_fat", "fiber", "sugar", "sodium_mg", "chol_mg"]
# USDA nutrient ids -> our keys (energy: 1008 kcal, 2047/2048 Atwater kcal for Foundation foods)
FDC_NUT = {1008: "kcal", 2048: "kcal2", 2047: "kcal3", 1003: "protein", 1005: "carbs", 1004: "fat",
           1258: "sat_fat", 1079: "fiber", 2000: "sugar", 1063: "sugar2", 1093: "sodium_mg", 1253: "chol_mg"}

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS products(
  id TEXT PRIMARY KEY,          -- off:<code> | usda:<fdc_id>
  source TEXT, code TEXT, name TEXT, brand TEXT,
  serving_label TEXT, serving_g REAL, unit TEXT, portions TEXT, image TEXT,
  kcal REAL, protein REAL, carbs REAL, fat REAL, sat_fat REAL, fiber REAL, sugar REAL,
  sodium_mg REAL, chol_mg REAL, generic INTEGER DEFAULT 0, updated INTEGER);
CREATE INDEX IF NOT EXISTS idx_code ON products(code);
CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(name, brand, content='products', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS p_ai AFTER INSERT ON products BEGIN
  INSERT INTO products_fts(rowid,name,brand) VALUES (new.rowid,new.name,new.brand); END;
CREATE TRIGGER IF NOT EXISTS p_ad AFTER DELETE ON products BEGIN
  INSERT INTO products_fts(products_fts,rowid,name,brand) VALUES('delete',old.rowid,old.name,old.brand); END;
CREATE TRIGGER IF NOT EXISTS p_au AFTER UPDATE ON products BEGIN
  INSERT INTO products_fts(products_fts,rowid,name,brand) VALUES('delete',old.rowid,old.name,old.brand);
  INSERT INTO products_fts(rowid,name,brand) VALUES (new.rowid,new.name,new.brand); END;
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
"""


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def norm_code(c):
    c = re.sub(r"\D", "", c or "")
    if len(c) == 12:
        c = "0" + c
    elif len(c) == 14 and c.startswith("0"):
        c = c[1:]
    return c


def iid(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def fnum(v):
    try:
        f = float(v)
        return f if f == f and f >= 0 else None
    except (TypeError, ValueError):
        return None


def download(url, dest):
    log("download", url)
    tmp = dest + ".part"
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)
    os.replace(tmp, dest)
    return dest


def meta_get(con, k, d=None):
    r = con.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    return r[0] if r else d


def meta_set(con, k, v):
    con.execute("INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)", (k, str(v)))


UPSERT = ("INSERT OR REPLACE INTO products(id,source,code,name,brand,serving_label,serving_g,unit,portions,image,"
          + ",".join(NUT_KEYS) + ",generic,updated) VALUES(" + ",".join("?" * (12 + len(NUT_KEYS))) + ")")


def off_is_us(code, countries):
    return "en:united-states" in (countries or "") or (len(code) == 13 and code.startswith("0"))


def mg100(v, limit_g):
    """OFF g/100g -> mg/100g. Values above what any food can hold (pure salt is ~39 g sodium/100 g,
    egg yolk ~1.1 g cholesterol) were typed in mg by the contributor, so they are already mg."""
    if v is None or v < 0:
        return None
    if v > limit_g:
        return round(v, 1) if v <= limit_g * 1000 else None
    return round(v * 1000, 1)


def off_row(code, name, brand, serving, sq, image, n, ts):
    kcal = n.get("kcal")
    if kcal is None and n.get("kj") is not None:
        kcal = round(n["kj"] / 4.184, 1)
    if not name or kcal is None:
        return None
    na = n.get("sodium")
    ch = n.get("chol")
    unit = "ml" if re.search(r"\d\s*ml\b|fl\.? ?oz", (serving or "").lower()) else "g"
    return ("off:" + code, "off", code, name.strip()[:200], (brand or "").split(",")[0].strip()[:100],
            (serving or "").strip()[:80] or None, sq, unit, None, image or None,
            kcal, n.get("protein"), n.get("carbs"), n.get("fat"), n.get("sat_fat"), n.get("fiber"), n.get("sugar"),
            mg100(na, 40), mg100(ch, 5), 0, ts)


def load_off_full(con):
    path = download(OFF_CSV, f"{WORK}/off.csv.gz")
    csv.field_size_limit(1 << 30)
    n_in = n_out = 0
    with gzip.open(path, "rt", encoding="utf-8", errors="replace", newline="") as f:
        rd = csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE)
        hdr = next(rd)
        ix = {h: i for i, h in enumerate(hdr)}
        g = lambda row, k: row[ix[k]] if k in ix and ix[k] < len(row) else ""
        batch = []
        for row in rd:
            n_in += 1
            code = norm_code(g(row, "code"))
            if not code or not off_is_us(code, g(row, "countries_tags")):
                continue
            n = {"kcal": fnum(g(row, "energy-kcal_100g")), "kj": fnum(g(row, "energy_100g")),
                 "protein": fnum(g(row, "proteins_100g")), "carbs": fnum(g(row, "carbohydrates_100g")),
                 "fat": fnum(g(row, "fat_100g")), "sat_fat": fnum(g(row, "saturated-fat_100g")),
                 "fiber": fnum(g(row, "fiber_100g")), "sugar": fnum(g(row, "sugars_100g")),
                 "sodium": fnum(g(row, "sodium_100g")), "chol": fnum(g(row, "cholesterol_100g"))}
            r = off_row(code, g(row, "product_name"), g(row, "brands"), g(row, "serving_size"),
                        fnum(g(row, "serving_quantity")), g(row, "image_small_url"), n,
                        int(fnum(g(row, "last_modified_t")) or 0))
            if r:
                batch.append(r)
                n_out += 1
            if len(batch) >= 5000:
                con.executemany(UPSERT, batch); batch.clear()
        con.executemany(UPSERT, batch)
    meta_set(con, "off_full", int(time.time()))
    meta_set(con, "off_delta_ts", int(time.time()) - 86400)
    os.remove(path)
    log(f"OFF full: {n_in} rows read, {n_out} US products loaded")


def apply_off_deltas(con):
    last = int(meta_get(con, "off_delta_ts", "0"))
    with urllib.request.urlopen(urllib.request.Request(OFF_DELTA + "index.txt", headers=UA), timeout=60) as r:
        files = [l.strip() for l in r.read().decode().splitlines() if l.strip().endswith(".json.gz")]
    todo = []
    for fn in files:
        m = re.match(r"openfoodfacts_products_(\d+)_(\d+)\.json\.gz", fn)
        if m and int(m.group(2)) > last:
            todo.append((int(m.group(2)), fn))
    todo.sort()
    total = 0
    for end, fn in todo:
        path = download(OFF_DELTA + fn, f"{WORK}/delta.json.gz")
        batch = []
        with gzip.open(path, "rt", encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    p = json.loads(line)
                except ValueError:
                    continue
                code = norm_code(p.get("code") or p.get("_id"))
                if not code or not off_is_us(code, ",".join(p.get("countries_tags") or [])):
                    continue
                nu = p.get("nutriments") or {}
                n = {"kcal": fnum(nu.get("energy-kcal_100g")), "kj": fnum(nu.get("energy_100g")),
                     "protein": fnum(nu.get("proteins_100g")), "carbs": fnum(nu.get("carbohydrates_100g")),
                     "fat": fnum(nu.get("fat_100g")), "sat_fat": fnum(nu.get("saturated-fat_100g")),
                     "fiber": fnum(nu.get("fiber_100g")), "sugar": fnum(nu.get("sugars_100g")),
                     "sodium": fnum(nu.get("sodium_100g")), "chol": fnum(nu.get("cholesterol_100g"))}
                name = p.get("product_name") or p.get("product_name_en")
                r = off_row(code, name, p.get("brands"), p.get("serving_size"), fnum(p.get("serving_quantity")),
                            p.get("image_small_url") or p.get("image_front_small_url"), n,
                            int(p.get("last_modified_t") or 0))
                if r:
                    batch.append(r)
        con.executemany(UPSERT, batch)
        total += len(batch)
        meta_set(con, "off_delta_ts", end)
        con.commit()
        os.remove(path)
    log(f"OFF deltas: {len(todo)} files, {total} US products upserted")


def fdc_latest():
    with urllib.request.urlopen(urllib.request.Request(FDC_PAGE, headers=UA), timeout=60) as r:
        html = r.read().decode("utf-8", "replace")
    out = {}
    for kind in ("branded_food", "foundation_food", "sr_legacy_food"):
        names = sorted(set(re.findall(rf"FoodData_Central_{kind}_csv_[0-9-]+\.zip", html)))
        if names:
            out[kind] = names[-1]
    return out


def load_fdc(con, latest):
    for kind, fname in latest.items():
        need = {"food.csv", "food_nutrient.csv"} | ({"branded_food.csv"} if kind == "branded_food" else set())
        zpath, names = None, {}
        for attempt in range(2):
            zpath = download(FDC_BASE + fname, f"{WORK}/{kind}.zip")
            try:
                with zipfile.ZipFile(zpath) as z:
                    names = {os.path.basename(n): n for n in z.namelist()}
            except zipfile.BadZipFile:
                names = {}
            if need <= set(names):
                break
            log(f"USDA {kind}: package incomplete (missing {sorted(need - set(names))}), attempt {attempt + 1}")
            time.sleep(30)
        if not need <= set(names):
            log(f"USDA {kind}: skipped this run (retried by the Sunday rebuild)")
            os.remove(zpath)
            meta_set(con, "fdc_" + kind, fname)
            continue
        with zipfile.ZipFile(zpath) as z:
            rd = lambda fn: csv.DictReader(io.TextIOWrapper(z.open(names[fn]), encoding="utf-8", errors="replace"))
            con.execute("PRAGMA temp_store=FILE")
            con.execute("PRAGMA cache_size=-65536")
            for t in ("tmp_nut", "tmp_piv", "tmp_food"):
                con.execute(f"DROP TABLE IF EXISTS {t}")
            con.execute("CREATE TEMP TABLE tmp_nut(fdc_id INTEGER, k TEXT, amt REAL)")
            batch = []
            for row in rd("food_nutrient.csv"):
                k = FDC_NUT.get(iid(row["nutrient_id"]))
                if k and iid(row["fdc_id"]) is not None:
                    a = fnum(row["amount"])
                    if a is not None:
                        batch.append((iid(row["fdc_id"]), k, a))
                if len(batch) >= 20000:
                    con.executemany("INSERT INTO tmp_nut VALUES(?,?,?)", batch); batch.clear()
            con.executemany("INSERT INTO tmp_nut VALUES(?,?,?)", batch)
            keys = sorted(set(FDC_NUT.values()))
            con.execute("CREATE TEMP TABLE tmp_piv(fdc_id INTEGER PRIMARY KEY, " + ",".join(f"{k} REAL" for k in keys) + ")")
            con.execute("INSERT INTO tmp_piv SELECT fdc_id," + ",".join(f"max(CASE k WHEN '{k}' THEN amt END)" for k in keys)
                        + " FROM tmp_nut GROUP BY fdc_id")
            con.execute("DROP TABLE tmp_nut")
            con.execute("CREATE TEMP TABLE tmp_food(fdc_id INTEGER PRIMARY KEY, description TEXT)")
            batch = []
            for row in rd("food.csv"):
                if row.get("data_type", kind) == kind and iid(row["fdc_id"]) is not None:
                    batch.append((iid(row["fdc_id"]), row["description"]))
                if len(batch) >= 20000:
                    con.executemany("INSERT OR REPLACE INTO tmp_food VALUES(?,?)", batch); batch.clear()
            con.executemany("INSERT OR REPLACE INTO tmp_food VALUES(?,?)", batch)
            pcols = ",".join(keys)

            def getnut(fid):
                r = con.execute(f"SELECT {pcols} FROM tmp_piv WHERE fdc_id=?", (fid,)).fetchone()
                return None if r is None else {k: v for k, v in zip(keys, r) if v is not None}

            def getname(fid):
                r = con.execute("SELECT description FROM tmp_food WHERE fdc_id=?", (fid,)).fetchone()
                return r and r[0]

            portions = {}
            if kind != "branded_food" and "food_portion.csv" in names:
                units = {}
                if "measure_unit.csv" in names:
                    units = {r["id"]: r["name"] for r in rd("measure_unit.csv")}
                for r in rd("food_portion.csv"):
                    g = fnum(r.get("gram_weight"))
                    if not g or iid(r.get("fdc_id")) is None:
                        continue
                    unit = units.get(r.get("measure_unit_id"), "")
                    unit = "" if unit == "undetermined" else unit
                    label = " ".join(x for x in [r.get("amount") or "1", unit, r.get("portion_description") or "",
                                                 r.get("modifier") or ""] if x and x.strip()).strip()
                    label = re.sub(r"^1\.0 ", "1 ", label)
                    portions.setdefault(int(r["fdc_id"]), []).append({"label": label[:60], "g": round(g, 1)})
            n_out = 0
            batch = []

            def nv(n, k):
                return n.get(k)

            if kind == "branded_food":
                for row in rd("branded_food.csv"):
                    fid = iid(row["fdc_id"])
                    if fid is None:
                        continue
                    code = norm_code(row.get("gtin_upc"))
                    if not code:
                        continue
                    n = getnut(fid)
                    name = getname(fid)
                    if not code or not n or not name or n.get("kcal") is None:
                        continue
                    if row.get("discontinued_date"):
                        continue
                    su = (row.get("serving_size_unit") or "").lower()
                    sg = fnum(row.get("serving_size"))
                    unit = "ml" if su in ("ml", "mlt") else "g"
                    hh = (row.get("household_serving_fulltext") or "").strip()
                    label = f"{hh} ({sg:g} {unit})" if hh and sg else (f"{sg:g} {unit}" if sg else None)
                    brand = (row.get("brand_name") or row.get("brand_owner") or "").strip().title()
                    batch.append(("usda:" + str(fid), "usda", code, name.strip().title()[:200], brand[:100], label, sg,
                                  unit, None, None, n.get("kcal"), nv(n, "protein"), nv(n, "carbs"), nv(n, "fat"),
                                  nv(n, "sat_fat"), nv(n, "fiber"), n.get("sugar", n.get("sugar2")),
                                  nv(n, "sodium_mg"), nv(n, "chol_mg"), 0, int(time.time())))
                    n_out += 1
                    if len(batch) >= 5000:
                        con.executemany(UPSERT, batch); batch.clear()
            else:
                for fid, name in con.execute("SELECT fdc_id,description FROM tmp_food").fetchall():
                    n = getnut(fid)
                    if not n:
                        continue
                    kcal = n.get("kcal", n.get("kcal2", n.get("kcal3")))
                    if kcal is None:
                        continue
                    pl = portions.get(fid) or []
                    sv = pl[0] if pl else None
                    batch.append(("usda:" + str(fid), "usda", None, name.strip()[:200], "USDA", sv and sv["label"],
                                  sv and sv["g"], "g", json.dumps(pl[:12]) if pl else None, None, kcal,
                                  nv(n, "protein"), nv(n, "carbs"), nv(n, "fat"), nv(n, "sat_fat"), nv(n, "fiber"),
                                  n.get("sugar", n.get("sugar2")), nv(n, "sodium_mg"), nv(n, "chol_mg"), 1,
                                  int(time.time())))
                    n_out += 1
            con.executemany(UPSERT, batch)
            con.execute("DROP TABLE tmp_piv")
            con.execute("DROP TABLE tmp_food")
            con.commit()
            log(f"USDA {kind}: {n_out} foods loaded from {fname}")
        os.remove(zpath)
        meta_set(con, "fdc_" + kind, fname)
    con.commit()


def full():
    os.makedirs(WORK, exist_ok=True)
    new = DB + ".new"
    for ext in ("", "-wal", "-shm"):
        if os.path.exists(new + ext):
            os.remove(new + ext)
    con = sqlite3.connect(new)
    con.executescript(SCHEMA)
    con.execute("PRAGMA synchronous=OFF")
    latest = fdc_latest()
    load_fdc(con, latest)
    load_off_full(con)
    con.commit()
    apply_off_deltas(con)
    meta_set(con, "built", int(time.time()))
    con.commit()
    con.close()  # drop any half-read statements that would lock the FTS table
    con = sqlite3.connect(new)
    con.execute("INSERT INTO products_fts(products_fts) VALUES('optimize')")
    con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    con.execute("PRAGMA journal_mode=DELETE")
    con.commit()
    con.close()
    os.replace(new, DB)
    log("full rebuild done:", DB)


def nightly():
    if not os.path.exists(DB) or datetime.date.today().weekday() == 6:
        return full()
    con = sqlite3.connect(DB)
    con.executescript(SCHEMA)
    try:
        latest = fdc_latest()
        if any(meta_get(con, "fdc_" + k) != v for k, v in latest.items()):
            con.close()
            log("new USDA release found")
            return full()
    except Exception as e:  # USDA page down: keep going with OFF deltas
        log("USDA check failed:", e)
    os.makedirs(WORK, exist_ok=True)
    apply_off_deltas(con)
    meta_set(con, "nightly", int(time.time()))
    con.commit()
    con.close()


if __name__ == "__main__":
    {"full": full, "nightly": nightly}[sys.argv[1] if len(sys.argv) > 1 else "nightly"]()
