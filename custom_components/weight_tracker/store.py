"""SQLite storage for Weight Tracker (sync; call from the executor)."""
from __future__ import annotations

import copy
import datetime as dt
import json
import sqlite3
import threading

from .const import DEFAULT_SETTINGS, MEALS, NUT

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS entries(
  id INTEGER PRIMARY KEY, day TEXT, meal TEXT, ts TEXT,
  food_id TEXT, name TEXT, brand TEXT, per100 TEXT,
  amount REAL, portion_label TEXT, portion_g REAL, grams REAL,
  kcal REAL, protein REAL, carbs REAL, fat REAL, sat_fat REAL, fiber REAL, sugar REAL,
  sodium_mg REAL, chol_mg REAL, source TEXT);
CREATE INDEX IF NOT EXISTS e_day ON entries(day);
CREATE TABLE IF NOT EXISTS foods(
  id TEXT PRIMARY KEY, code TEXT, name TEXT, brand TEXT, data TEXT,
  custom INTEGER DEFAULT 0, favorite INTEGER DEFAULT 0, last_used TEXT, use_count INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS f_code ON foods(code);
CREATE TABLE IF NOT EXISTS weights(
  id INTEGER PRIMARY KEY, ts TEXT, day TEXT, weight REAL, body_fat REAL, source TEXT,
  UNIQUE(source, ts));
CREATE INDEX IF NOT EXISTS w_day ON weights(day);
CREATE TABLE IF NOT EXISTS bp(
  id INTEGER PRIMARY KEY, ts TEXT, day TEXT, systolic INTEGER, diastolic INTEGER, pulse INTEGER,
  source TEXT, note TEXT, UNIQUE(source, ts));
CREATE TABLE IF NOT EXISTS water(id INTEGER PRIMARY KEY, ts TEXT, day TEXT, oz REAL, source TEXT);
CREATE INDEX IF NOT EXISTS wa_day ON water(day);
CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, ts TEXT, day TEXT, text TEXT, tag TEXT);
CREATE INDEX IF NOT EXISTS n_day ON notes(day);
"""


def _merge(base, patch):
    for k, v in (patch or {}).items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _merge(base[k], v)
        else:
            base[k] = v
    return base


def _r(v, n=1):
    return None if v is None else round(v, n)


class Store:
    def __init__(self, path: str) -> None:
        self.path = path
        self.lock = threading.Lock()
        self.con: sqlite3.Connection | None = None

    # ---------- plumbing
    def open(self):
        self.con = sqlite3.connect(self.path, check_same_thread=False, timeout=15)
        self.con.row_factory = sqlite3.Row
        self.con.executescript(SCHEMA)
        self.con.commit()

    def close(self):
        if self.con:
            self.con.close()
            self.con = None

    def _q(self, sql, args=()):
        with self.lock:
            return [dict(r) for r in self.con.execute(sql, args).fetchall()]

    def _x(self, sql, args=()):
        with self.lock:
            cur = self.con.execute(sql, args)
            self.con.commit()
            return cur.lastrowid

    # ---------- settings
    def settings(self):
        s = copy.deepcopy(DEFAULT_SETTINGS)
        row = self._q("SELECT v FROM settings WHERE k='settings'")
        if row:
            _merge(s, json.loads(row[0]["v"]))
        return s

    def set_settings(self, patch):
        s = _merge(self.settings(), patch)
        self._x("INSERT OR REPLACE INTO settings(k,v) VALUES('settings',?)", (json.dumps(s),))
        return s

    # ---------- foods (recents / custom / favorites)
    def remember_food(self, food, amount, portion_label, now):
        if not food.get("id"):
            return
        data = dict(food)
        data["last_amount"], data["last_portion"] = amount, portion_label
        with self.lock:
            cur = self.con.execute("SELECT custom,favorite,use_count FROM foods WHERE id=?", (food["id"],)).fetchone()
            custom = cur["custom"] if cur else int(bool(food.get("custom")))
            fav = cur["favorite"] if cur else 0
            uc = (cur["use_count"] if cur else 0) + 1
            self.con.execute("INSERT OR REPLACE INTO foods(id,code,name,brand,data,custom,favorite,last_used,use_count)"
                             " VALUES(?,?,?,?,?,?,?,?,?)",
                             (food["id"], food.get("code"), food.get("name"), food.get("brand"), json.dumps(data),
                              custom, fav, now, uc))
            self.con.commit()

    def save_custom_food(self, food, now):
        fid = food.get("id") or f"custom:{int(dt.datetime.now().timestamp() * 1000)}"
        food = dict(food, id=fid, source="custom", custom=True)
        self._x("INSERT OR REPLACE INTO foods(id,code,name,brand,data,custom,favorite,last_used,use_count)"
                " VALUES(?,?,?,?,?,1,COALESCE((SELECT favorite FROM foods WHERE id=?),0),?,"
                "COALESCE((SELECT use_count FROM foods WHERE id=?),0))",
                (fid, food.get("code"), food.get("name"), food.get("brand"), json.dumps(food), fid, now, fid))
        return food

    def delete_food(self, fid):
        self._x("DELETE FROM foods WHERE id=?", (fid,))

    def set_favorite(self, food, fav, now):
        if not self._q("SELECT id FROM foods WHERE id=?", (food["id"],)):
            self.remember_food(food, food.get("last_amount", 1), food.get("last_portion"), now)
            self._x("UPDATE foods SET use_count=0 WHERE id=?", (food["id"],))
        self._x("UPDATE foods SET favorite=? WHERE id=?", (1 if fav else 0, food["id"]))

    def _food_rows(self, rows):
        out = []
        for r in rows:
            d = json.loads(r["data"])
            d["favorite"], d["custom"], d["use_count"] = bool(r["favorite"]), bool(r["custom"]), r["use_count"]
            out.append(d)
        return out

    def recent_foods(self, limit=40):
        return self._food_rows(self._q(
            "SELECT * FROM foods ORDER BY favorite DESC, last_used DESC LIMIT ?", (limit,)))

    def local_search(self, q, limit=15):
        like = f"%{q.lower()}%"
        return self._food_rows(self._q(
            "SELECT * FROM foods WHERE lower(name) LIKE ? OR lower(brand) LIKE ? "
            "ORDER BY favorite DESC, use_count DESC LIMIT ?", (like, like, limit)))

    def local_barcode(self, codes):
        ph = ",".join("?" * len(codes))
        return self._food_rows(self._q(f"SELECT * FROM foods WHERE code IN ({ph}) ORDER BY custom DESC", list(codes)))

    # ---------- entries
    @staticmethod
    def _nutrients(per100, grams, direct):
        if per100 and grams is not None:
            return {k: (None if per100.get(k) is None else per100[k] * grams / 100.0) for k in NUT}
        return {k: direct.get(k) for k in NUT}

    def add_entry(self, day, meal, ts, food, amount, portion_label, portion_g, direct=None, source="manual"):
        per100 = food.get("per100") if food else None
        grams = amount * portion_g if (per100 and portion_g) else None
        n = self._nutrients(per100, grams, direct or {})
        return self._x(
            "INSERT INTO entries(day,meal,ts,food_id,name,brand,per100,amount,portion_label,portion_g,grams,"
            + ",".join(NUT) + ",source) VALUES(" + ",".join("?" * (12 + len(NUT))) + ")",
            (day, meal, ts, food.get("id") if food else None, (food or {}).get("name") or (direct or {}).get("name"),
             (food or {}).get("brand"), json.dumps(per100) if per100 else None, amount, portion_label, portion_g,
             grams, *[n[k] for k in NUT], source))

    def update_entry(self, eid, amount=None, portion_label=None, portion_g=None, meal=None, day=None, direct=None):
        rows = self._q("SELECT * FROM entries WHERE id=?", (eid,))
        if not rows:
            raise ValueError("entry not found")
        e = rows[0]
        amount = e["amount"] if amount is None else amount
        portion_g = e["portion_g"] if portion_g is None else portion_g
        portion_label = e["portion_label"] if portion_label is None else portion_label
        per100 = json.loads(e["per100"]) if e["per100"] else None
        if per100 and portion_g:
            grams = amount * portion_g
            n = self._nutrients(per100, grams, {})
        else:
            grams = None
            old_amt = e["amount"] or 1
            n = direct or {k: (None if e[k] is None else e[k] * amount / old_amt) for k in NUT}
        self._x("UPDATE entries SET amount=?,portion_label=?,portion_g=?,grams=?,meal=?,day=?,"
                + ",".join(f"{k}=?" for k in NUT) + " WHERE id=?",
                (amount, portion_label, portion_g, grams, meal or e["meal"], day or e["day"],
                 *[n.get(k) for k in NUT], eid))

    def delete_entry(self, eid):
        self._x("DELETE FROM entries WHERE id=?", (eid,))

    def copy_meal(self, from_day, meal, to_day, to_meal, ts):
        rows = self._q("SELECT * FROM entries WHERE day=? AND meal=?", (from_day, meal))
        for e in rows:
            self._x("INSERT INTO entries(day,meal,ts,food_id,name,brand,per100,amount,portion_label,portion_g,grams,"
                    + ",".join(NUT) + ",source) VALUES(" + ",".join("?" * (12 + len(NUT))) + ")",
                    (to_day, to_meal or meal, ts, e["food_id"], e["name"], e["brand"], e["per100"], e["amount"],
                     e["portion_label"], e["portion_g"], e["grams"], *[e[k] for k in NUT], "copy"))
        return len(rows)

    # ---------- water / weight / bp / notes
    def add_water(self, day, ts, oz, source="manual"):
        return self._x("INSERT INTO water(ts,day,oz,source) VALUES(?,?,?,?)", (ts, day, oz, source))

    def add_weight(self, day, ts, weight, body_fat=None, source="manual"):
        with self.lock:
            self.con.execute("INSERT INTO weights(ts,day,weight,body_fat,source) VALUES(?,?,?,?,?) "
                             "ON CONFLICT(source,ts) DO UPDATE SET weight=excluded.weight,"
                             "body_fat=COALESCE(excluded.body_fat,body_fat)", (ts, day, weight, body_fat, source))
            self.con.commit()

    def add_bp(self, day, ts, sys_, dia, pulse=None, source="manual", note=None):
        with self.lock:
            self.con.execute("INSERT INTO bp(ts,day,systolic,diastolic,pulse,source,note) VALUES(?,?,?,?,?,?,?) "
                             "ON CONFLICT(source,ts) DO UPDATE SET systolic=excluded.systolic,"
                             "diastolic=excluded.diastolic,pulse=COALESCE(excluded.pulse,pulse)",
                             (ts, day, sys_, dia, pulse, source, note))
            self.con.commit()

    def add_note(self, day, ts, text, tag=None):
        return self._x("INSERT INTO notes(ts,day,text,tag) VALUES(?,?,?,?)", (ts, day, text, tag))

    def delete_row(self, table, rid):
        if table not in ("water", "weights", "bp", "notes"):
            raise ValueError("bad table")
        self._x(f"DELETE FROM {table} WHERE id=?", (rid,))

    # ---------- reads
    def day(self, day):
        entries = self._q("SELECT id,meal,ts,food_id,name,brand,amount,portion_label,portion_g,grams,per100,"
                          + ",".join(NUT) + " FROM entries WHERE day=? ORDER BY id", (day,))
        for e in entries:
            e["per100"] = json.loads(e["per100"]) if e["per100"] else None
        totals = {k: _r(sum((e[k] or 0) for e in entries), 1) for k in NUT}
        meals = {m: _r(sum((e["kcal"] or 0) for e in entries if e["meal"] == m), 0) for m in MEALS}
        water = self._q("SELECT id,ts,oz,source FROM water WHERE day=? ORDER BY ts", (day,))
        return {
            "date": day, "entries": entries, "totals": totals, "meal_kcal": meals,
            "water": water, "water_oz": _r(sum(w["oz"] for w in water), 1),
            "weights": self._q("SELECT id,ts,weight,body_fat,source FROM weights WHERE day=? ORDER BY ts", (day,)),
            "bp": self._q("SELECT id,ts,systolic,diastolic,pulse,source,note FROM bp WHERE day=? ORDER BY ts", (day,)),
            "notes": self._q("SELECT id,ts,text,tag FROM notes WHERE day=? ORDER BY ts", (day,)),
        }

    def range(self, start, end):
        days = self._q("SELECT day," + ",".join(f"round(sum({k}),1) AS {k}" for k in NUT)
                       + ", count(*) AS n FROM entries WHERE day BETWEEN ? AND ? GROUP BY day ORDER BY day",
                       (start, end))
        meals = self._q("SELECT day,meal,round(sum(kcal),0) AS kcal FROM entries WHERE day BETWEEN ? AND ? "
                        "GROUP BY day,meal", (start, end))
        water = self._q("SELECT day,round(sum(oz),1) AS oz FROM water WHERE day BETWEEN ? AND ? GROUP BY day",
                        (start, end))
        weights = self._q("SELECT id,day,ts,weight,body_fat,source FROM weights WHERE day BETWEEN ? AND ? "
                          "ORDER BY ts", (start, end))
        bp = self._q("SELECT id,day,ts,systolic,diastolic,pulse,source FROM bp WHERE day BETWEEN ? AND ? "
                     "ORDER BY ts", (start, end))
        notes = self._q("SELECT id,day,ts,text FROM notes WHERE day BETWEEN ? AND ? ORDER BY ts DESC",
                        (start, end))
        return {"start": start, "end": end, "days": days, "meals": meals, "water": water,
                "weights": weights, "bp": bp, "notes": notes}

    def history(self, kind, limit=60):
        if kind == "weights":
            return self._q("SELECT * FROM weights ORDER BY ts DESC LIMIT ?", (limit,))
        if kind == "bp":
            return self._q("SELECT * FROM bp ORDER BY ts DESC LIMIT ?", (limit,))
        if kind == "notes":
            return self._q("SELECT * FROM notes ORDER BY ts DESC LIMIT ?", (limit,))
        raise ValueError("bad kind")

    def summary(self, today):
        s = self.settings()
        d = self.day(today)
        last_w = self._q("SELECT weight,ts,body_fat FROM weights ORDER BY ts DESC LIMIT 1")
        first_w = self._q("SELECT weight,ts FROM weights ORDER BY ts LIMIT 1")
        week_ago = (dt.date.fromisoformat(today) - dt.timedelta(days=7)).isoformat()
        w7 = self._q("SELECT weight FROM weights WHERE day<=? ORDER BY ts DESC LIMIT 1", (week_ago,))
        last_bp = self._q("SELECT systolic,diastolic,pulse,ts FROM bp ORDER BY ts DESC LIMIT 1")
        start7 = (dt.date.fromisoformat(today) - dt.timedelta(days=7)).isoformat()
        yday = (dt.date.fromisoformat(today) - dt.timedelta(days=1)).isoformat()
        avg = self._q("SELECT avg(k) AS a, count(*) AS n FROM (SELECT sum(kcal) AS k FROM entries "
                      "WHERE day BETWEEN ? AND ? GROUP BY day)", (start7, yday))
        weight = last_w[0]["weight"] if last_w else None
        start = s.get("start_weight") or (first_w[0]["weight"] if first_w else None)
        goal = s.get("goal_weight")
        h = s.get("height_in")
        return {
            "date": today, "settings": s, "totals": d["totals"], "meal_kcal": d["meal_kcal"],
            "water_oz": d["water_oz"], "entries": len(d["entries"]),
            "weight": weight, "weight_ts": last_w[0]["ts"] if last_w else None,
            "body_fat": last_w[0]["body_fat"] if last_w else None,
            "weight_change_7d": _r(weight - w7[0]["weight"], 1) if (weight and w7) else None,
            "start_weight": start, "goal_weight": goal,
            "to_goal": _r(weight - goal, 1) if (weight and goal) else None,
            "lost": _r(start - weight, 1) if (weight and start) else None,
            "bmi": _r(703 * weight / (h * h), 1) if (weight and h) else None,
            "bp": last_bp[0] if last_bp else None,
            "kcal_avg_7d": _r(avg[0]["a"], 0) if avg and avg[0]["a"] else None,
            "has_weight_today": bool(d["weights"]),
        }
