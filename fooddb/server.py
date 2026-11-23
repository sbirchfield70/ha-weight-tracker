#!/usr/bin/env python3
"""Read-only food lookup API.

GET /health                -> counts and update times
GET /barcode/<digits>      -> {"code":..,"products":[..]}  (USDA label first, then Open Food Facts)
GET /search?q=..&limit=25  -> {"products":[..]}             (generic USDA foods ranked up)
GET /food/<id>             -> product                        (id = off:<code> | usda:<fdc_id>)
"""
import json, os, re, sqlite3, time, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB = "/opt/fooddb/fooddb.sqlite"
NUT = ["kcal", "protein", "carbs", "fat", "sat_fat", "fiber", "sugar", "sodium_mg", "chol_mg"]
COLS = "id,source,code,name,brand,serving_label,serving_g,unit,portions,image,generic," + ",".join(NUT)


def norm_code(c):
    c = re.sub(r"\D", "", c or "")
    if len(c) == 12:
        c = "0" + c
    elif len(c) == 14 and c.startswith("0"):
        c = c[1:]
    return c


def con():
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=10)
    c.row_factory = sqlite3.Row
    return c


def out(r):
    d = dict(r)
    d["per100"] = {k: (round(d.pop(k), 2) if d[k] is not None else None) for k in NUT}
    d["portions"] = json.loads(d["portions"]) if d["portions"] else []
    if d["serving_g"] and not any(p["g"] == d["serving_g"] for p in d["portions"]):
        d["portions"].insert(0, {"label": d["serving_label"] or f'{d["serving_g"]:g} {d["unit"]}', "g": d["serving_g"]})
    d["generic"] = bool(d["generic"])
    return d


def fts_query(q):
    words = re.findall(r"[\w']+", q.lower())
    return " ".join('"%s"*' % w.replace('"', "") for w in words[:8])


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(u.query)
        parts = [p for p in u.path.split("/") if p]
        try:
            if not os.path.exists(DB):
                return self.send(503, {"error": "database not built yet"})
            c = con()
            if parts == ["health"]:
                meta = dict(c.execute("SELECT k,v FROM meta").fetchall())
                counts = dict(c.execute("SELECT source,count(*) FROM products GROUP BY source").fetchall())
                return self.send(200, {"ok": True, "counts": counts, "meta": meta, "now": int(time.time())})
            if len(parts) == 2 and parts[0] == "barcode":
                raw = re.sub(r"\D", "", parts[1])
                codes = {norm_code(raw), raw, raw.lstrip("0")}
                if len(raw) == 8:  # UPC-E/EAN-8 stored as-is
                    codes.add(raw)
                ph = ",".join("?" * len(codes))
                rows = c.execute(f"SELECT {COLS} FROM products WHERE code IN ({ph}) "
                                 "ORDER BY CASE source WHEN 'usda' THEN 0 ELSE 1 END, updated DESC, rowid DESC",
                                 list(codes)).fetchall()
                seen, res = set(), []
                for r in rows:  # USDA keeps old label versions under the same GTIN: newest first, drop repeats
                    key = (r["source"], (r["name"] or "").lower(), round(r["kcal"] or 0))
                    if key not in seen:
                        seen.add(key)
                        res.append(out(r))
                return self.send(200, {"code": norm_code(raw), "products": res[:6]})
            if parts == ["search"]:
                q = (qs.get("q") or [""])[0].strip()
                lim = max(1, min(60, int((qs.get("limit") or ["25"])[0])))
                if len(q) < 2:
                    return self.send(200, {"products": []})
                fq = fts_query(q)
                rows = c.execute(
                    f"SELECT {','.join('p.' + x for x in COLS.split(','))} FROM products_fts f "
                    "JOIN products p ON p.rowid=f.rowid WHERE products_fts MATCH ? "
                    "ORDER BY bm25(products_fts, 4.0, 1.0) - p.generic*3.0 - (length(p.name)<40)*0.5 LIMIT ?",
                    (fq, lim * 4)).fetchall()
                seen, res = set(), []
                for r in rows:
                    key = ((r["name"] or "").lower(), (r["brand"] or "").lower())
                    if key not in seen:
                        seen.add(key)
                        res.append(out(r))
                return self.send(200, {"products": res[:lim]})
            if len(parts) == 2 and parts[0] == "food":
                r = c.execute(f"SELECT {COLS} FROM products WHERE id=?", (urllib.parse.unquote(parts[1]),)).fetchone()
                return self.send(200, out(r)) if r else self.send(404, {"error": "not found"})
            return self.send(404, {"error": "unknown path"})
        except Exception as e:
            return self.send(500, {"error": str(e)})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), H).serve_forever()
