"""Weight Tracker: food log, barcode lookup, weight, water, blood pressure and notes."""
from __future__ import annotations

import datetime as dt
import logging
import re
import secrets

import voluptuous as vol
from aiohttp import web

from homeassistant.components import persistent_notification, webhook
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_time_change
from homeassistant.util import dt as dt_util

from .const import CONF_FOOD_DB, CONF_WEBHOOK, DASHBOARD_URL, DB_FILE, DEFAULT_FOOD_DB, DOMAIN, MEALS, NUT, SIGNAL_UPDATE
from .store import Store

_LOGGER = logging.getLogger(__name__)
PLATFORMS = ["sensor"]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)
OFF_LIVE = "https://world.openfoodfacts.org/api/v2/product/{}.json"
UA = {"User-Agent": "ha-weight-tracker/1.0 (+https://github.com/sbirchfield70/ha-weight-tracker)"}


def norm_code(c: str) -> str:
    c = re.sub(r"\D", "", c or "")
    if len(c) == 12:
        c = "0" + c
    elif len(c) == 14 and c.startswith("0"):
        c = c[1:]
    return c


def _num(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    m = re.search(r"-?\d+(?:[.,]\d+)?", str(v))
    return float(m.group(0).replace(",", ".")) if m else None


def _mg100(v, limit_g):
    """OFF g/100g -> mg/100g; values no food can reach were typed in mg already."""
    if v is None or v < 0:
        return None
    if v > limit_g:
        return round(v, 1) if v <= limit_g * 1000 else None
    return round(v * 1000, 1)


def _list(v):
    if v is None or v == "":
        return []
    if isinstance(v, list):
        return v
    if isinstance(v, str) and "\n" in v:
        return [x for x in v.split("\n") if x.strip()]
    return [v]


class WTData:
    """Runtime state shared by websocket, sensors and services."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, store: Store) -> None:
        self.hass, self.entry, self.store = hass, entry, store
        self.summary: dict = {}
        self.alerts: list[dict] = []
        self._unsubs: list = []
        self._alerted: dict[str, str] = {}

    # ---------- time helpers
    def now(self):
        return dt_util.now()

    def today(self) -> str:
        return self.now().date().isoformat()

    def ts(self) -> str:
        return self.now().replace(microsecond=0, tzinfo=None).isoformat()

    def parse_ts(self, v) -> tuple[str, str]:
        """Return (day, ts) in local time from ISO string / epoch / Shortcuts date."""
        if v in (None, ""):
            ts = self.ts()
            return ts[:10], ts
        d = None
        if isinstance(v, (int, float)) or (isinstance(v, str) and re.fullmatch(r"\d{9,11}", v.strip())):
            d = dt_util.as_local(dt_util.utc_from_timestamp(float(v)))
        else:
            s = str(v).strip()
            d = dt_util.parse_datetime(s)
            if d is None:
                for fmt in ("%b %d, %Y at %I:%M %p", "%B %d, %Y at %I:%M %p", "%m/%d/%Y, %I:%M %p",
                            "%m/%d/%y, %I:%M %p", "%Y-%m-%d"):
                    try:
                        d = dt.datetime.strptime(s.replace(" ", " "), fmt)
                        break
                    except ValueError:
                        continue
            if d is None:
                raise vol.Invalid(f"can't read date {s!r}")
            if d.tzinfo is not None:
                d = dt_util.as_local(d)
        d = d.replace(microsecond=0, tzinfo=None)
        return d.date().isoformat(), d.isoformat()

    # ---------- refresh
    async def async_refresh(self) -> None:
        self.summary = await self.hass.async_add_executor_job(self.store.summary, self.today())
        async_dispatcher_send(self.hass, SIGNAL_UPDATE)
        await self._check_over_goal()

    async def run(self, fn, *args):
        return await self.hass.async_add_executor_job(fn, *args)

    # ---------- food lookups
    @property
    def food_db(self) -> str:
        return (self.entry.options.get(CONF_FOOD_DB) or self.entry.data.get(CONF_FOOD_DB) or DEFAULT_FOOD_DB).rstrip("/")

    async def _get(self, url, timeout=10):
        sess = async_get_clientsession(self.hass)
        async with sess.get(url, timeout=timeout, headers=UA) as r:
            if r.status != 200:
                return None
            return await r.json(content_type=None)

    async def barcode(self, code: str) -> dict:
        raw = re.sub(r"\D", "", code or "")
        n = norm_code(raw)
        local = await self.run(self.store.local_barcode, list({raw, n}))
        products = list(local)
        source_ok = True
        try:
            res = await self._get(f"{self.food_db}/barcode/{raw}")
            products += (res or {}).get("products", [])
        except Exception as e:  # noqa: BLE001
            source_ok = False
            _LOGGER.warning("food db lookup failed: %s", e)
        if not products:
            live = await self._off_live(raw)
            if live:
                products.append(live)
        return {"code": n, "products": products, "food_db_ok": source_ok}

    async def _off_live(self, raw: str):
        try:
            res = await self._get(OFF_LIVE.format(raw) + "?fields=code,product_name,brands,serving_size,"
                                  "serving_quantity,nutriments,image_small_url", timeout=8)
        except Exception:  # noqa: BLE001
            return None
        p = (res or {}).get("product")
        if not p or not p.get("product_name"):
            return None
        nu = p.get("nutriments") or {}
        kcal = nu.get("energy-kcal_100g")
        if kcal is None and nu.get("energy_100g") is not None:
            kcal = nu["energy_100g"] / 4.184
        sod = nu.get("sodium_100g")
        chol = nu.get("cholesterol_100g")
        sg = _num(p.get("serving_quantity"))
        return {
            "id": "off:" + norm_code(p.get("code") or raw), "source": "off-live", "code": norm_code(p.get("code") or raw),
            "name": p.get("product_name"), "brand": (p.get("brands") or "").split(",")[0],
            "serving_label": p.get("serving_size"), "serving_g": sg,
            "unit": "ml" if re.search(r"\d\s*ml\b|fl\.? ?oz", (p.get("serving_size") or "").lower()) else "g", "image": p.get("image_small_url"),
            "portions": [{"label": p.get("serving_size") or f"{sg:g} g", "g": sg}] if sg else [],
            "per100": {"kcal": kcal, "protein": nu.get("proteins_100g"), "carbs": nu.get("carbohydrates_100g"),
                       "fat": nu.get("fat_100g"), "sat_fat": nu.get("saturated-fat_100g"),
                       "fiber": nu.get("fiber_100g"), "sugar": nu.get("sugars_100g"),
                       "sodium_mg": _mg100(_num(sod), 40),
                       "chol_mg": _mg100(_num(chol), 5)},
        }

    async def search(self, q: str) -> dict:
        local = await self.run(self.store.local_search, q)
        remote, ok = [], True
        try:
            from urllib.parse import quote
            res = await self._get(f"{self.food_db}/search?q={quote(q)}&limit=30")
            remote = (res or {}).get("products", [])
        except Exception as e:  # noqa: BLE001
            ok = False
            _LOGGER.warning("food db search failed: %s", e)
        seen = {f["id"] for f in local}
        return {"products": local + [p for p in remote if p["id"] not in seen], "food_db_ok": ok}

    async def food_db_health(self):
        try:
            return await self._get(f"{self.food_db}/health", timeout=5)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}

    # ---------- notifications
    async def notify(self, kind: str, title: str, message: str) -> None:
        s = self.summary.get("settings") or await self.run(self.store.settings)
        target = s.get("notify_target", "both")
        if target == "off":
            return
        if target in ("dashboard", "both"):
            self.alerts = [a for a in self.alerts if a["kind"] != kind][-9:]
            self.alerts.append({"kind": kind, "title": title, "message": message, "ts": self.ts()})
            persistent_notification.async_create(self.hass, message, title, f"{DOMAIN}_{kind}")
            async_dispatcher_send(self.hass, SIGNAL_UPDATE)
        if target in ("app", "both"):
            svc = (s.get("notify_service") or "").replace("notify.", "")
            if svc and self.hass.services.has_service("notify", svc):
                await self.hass.services.async_call(
                    "notify", svc,
                    {"title": title, "message": message,
                     "data": {"url": DASHBOARD_URL, "clickAction": DASHBOARD_URL, "group": "weight-tracker",
                              "tag": f"wt-{kind}"}},
                    blocking=False)
            else:
                _LOGGER.warning("notify.%s not found; app notification skipped", svc)

    def dismiss_alert(self, kind: str | None) -> None:
        kinds = [a["kind"] for a in self.alerts] if kind is None else [kind]
        self.alerts = [a for a in self.alerts if a["kind"] not in kinds]
        for k in kinds:
            persistent_notification.async_dismiss(self.hass, f"{DOMAIN}_{k}")
        async_dispatcher_send(self.hass, SIGNAL_UPDATE)

    async def _check_over_goal(self):
        s = self.summary.get("settings", {})
        kcal = (self.summary.get("totals") or {}).get("kcal") or 0
        goal = s.get("daily_kcal") or 0
        if s.get("over_goal_alert") and goal and kcal > goal and self._alerted.get("over") != self.today():
            self._alerted["over"] = self.today()
            await self.notify("over_goal", "Over your calorie goal",
                              f"You're at {kcal:,.0f} kcal today, {kcal - goal:,.0f} over your {goal:,} goal.")

    async def reminder(self, kind: str) -> None:
        await self.async_refresh()
        s, sm = self.summary["settings"], self.summary
        goal = s.get("daily_kcal") or 0
        kcal = (sm.get("totals") or {}).get("kcal") or 0
        if kind in ("breakfast", "lunch", "dinner"):
            if (sm.get("meal_kcal") or {}).get(kind):
                return
            await self.notify(kind, f"Log {kind}?",
                              f"Nothing logged for {kind} yet. {max(goal - kcal, 0):,.0f} kcal left today.")
        elif kind == "weigh_in":
            if sm.get("has_weight_today"):
                return
            await self.notify(kind, "Weigh-in", "No weight recorded today. Step on the scale when you get a chance.")
        elif kind == "water":
            goal_oz = s.get("water_goal_oz") or 0
            if goal_oz and (sm.get("water_oz") or 0) < goal_oz:
                await self.notify(kind, "Water", f"{sm.get('water_oz') or 0:g} of {goal_oz:g} oz so far today.")
        elif kind == "summary":
            t = sm.get("totals") or {}
            left = goal - kcal
            msg = (f"{kcal:,.0f} of {goal:,} kcal ({'%s left' % f'{left:,.0f}' if left >= 0 else '%s over' % f'{-left:,.0f}'})."
                   f" Protein {t.get('protein') or 0:.0f} g, carbs {t.get('carbs') or 0:.0f} g, fat {t.get('fat') or 0:.0f} g."
                   f" Water {sm.get('water_oz') or 0:g} oz.")
            if sm.get("weight"):
                msg += f" Weight {sm['weight']:g} lb"
                if sm.get("to_goal") is not None:
                    msg += f", {sm['to_goal']:g} to goal"
                msg += "."
            await self.notify(kind, "Today's summary", msg)

    @callback
    def schedule(self) -> None:
        for u in self._unsubs:
            u()
        self._unsubs = []
        s = self.summary.get("settings") or {}
        for kind, r in (s.get("reminders") or {}).items():
            if not r.get("enabled") or not r.get("time"):
                continue
            try:
                h, m = (int(x) for x in r["time"].split(":")[:2])
            except ValueError:
                continue

            async def _fire(now, kind=kind):
                await self.reminder(kind)

            self._unsubs.append(async_track_time_change(self.hass, _fire, hour=h, minute=m, second=0))

        async def _midnight(now):
            self.alerts = []
            await self.async_refresh()

        self._unsubs.append(async_track_time_change(self.hass, _midnight, hour=0, minute=0, second=10))

    def unload(self):
        for u in self._unsubs:
            u()
        self._unsubs = []

    # ---------- health ingest (webhook + service)
    async def ingest(self, body: dict, source: str) -> dict:
        added = {"weights": 0, "bp": 0, "water": 0, "notes": 0}
        unit = str(body.get("weight_unit") or body.get("unit") or "lb").lower()
        ws, wd = _list(body.get("weight")), _list(body.get("weight_date") or body.get("date"))
        bfs = _list(body.get("body_fat"))
        for i, w in enumerate(ws):
            val = _num(w)
            if not val:
                continue
            if "kg" in unit or "kg" in str(w).lower():
                val = val * 2.20462
            if val < 50 or val > 800:
                continue
            day, ts = self.parse_ts(wd[i] if i < len(wd) else (wd[0] if len(wd) == 1 else None))
            bf = _num(bfs[i]) if i < len(bfs) else None
            if bf is not None and bf <= 1:
                bf *= 100
            await self.run(self.store.add_weight, day, ts[:16] + ":00", round(val, 1), bf, source)
            added["weights"] += 1
        sy, di = _list(body.get("systolic")), _list(body.get("diastolic"))
        pu, bd = _list(body.get("pulse")), _list(body.get("bp_date") or body.get("date"))
        for i, s in enumerate(sy):
            s_, d_ = _num(s), _num(di[i]) if i < len(di) else None
            if not s_ or not d_:
                continue
            day, ts = self.parse_ts(bd[i] if i < len(bd) else (bd[0] if len(bd) == 1 else None))
            p = _num(pu[i]) if i < len(pu) else None
            await self.run(self.store.add_bp, day, ts[:16] + ":00", int(s_), int(d_), int(p) if p else None, source)
            added["bp"] += 1
        if _num(body.get("water_oz")):
            day, ts = self.parse_ts(body.get("water_date"))
            await self.run(self.store.add_water, day, ts, _num(body["water_oz"]), source)
            added["water"] += 1
        if body.get("note"):
            day, ts = self.parse_ts(body.get("note_date"))
            await self.run(self.store.add_note, day, ts, str(body["note"])[:2000], source)
            added["notes"] += 1
        await self.async_refresh()
        sm = self.summary
        t = sm.get("totals") or {}
        return {"ok": True, "added": added, "date": sm.get("date"), "kcal": t.get("kcal") or 0,
                "protein": t.get("protein") or 0, "carbs": t.get("carbs") or 0, "fat": t.get("fat") or 0,
                "fiber": t.get("fiber") or 0, "sugar": t.get("sugar") or 0, "sodium_mg": t.get("sodium_mg") or 0,
                "water_oz": sm.get("water_oz") or 0, "weight": sm.get("weight"),
                "kcal_goal": (sm.get("settings") or {}).get("daily_kcal")}


async def async_setup(hass: HomeAssistant, config) -> bool:
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    if CONF_WEBHOOK not in entry.data:
        hass.config_entries.async_update_entry(entry, data={**entry.data, CONF_WEBHOOK: secrets.token_hex(16)})
    store = Store(hass.config.path(DB_FILE))
    await hass.async_add_executor_job(store.open)
    data = WTData(hass, entry, store)
    hass.data[DOMAIN] = data
    await data.async_refresh()

    from . import websocket as ws_api
    ws_api.async_register(hass)
    _register_services(hass, data)

    async def _hook(hass_, webhook_id, request: web.Request):
        try:
            if request.content_type == "application/json":
                body = await request.json()
            else:
                body = dict(await request.post())
        except Exception:  # noqa: BLE001
            return web.json_response({"ok": False, "error": "send JSON"}, status=400)
        try:
            return web.json_response(await data.ingest(body or {}, "apple_health"))
        except vol.Invalid as e:
            return web.json_response({"ok": False, "error": str(e)}, status=400)

    webhook.async_register(hass, DOMAIN, "Weight Tracker (Apple Health)", entry.data[CONF_WEBHOOK], _hook,
                           allowed_methods=["POST", "PUT"])
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    data.schedule()
    entry.async_on_unload(entry.add_update_listener(_reload))
    return True


async def _reload(hass, entry):
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    webhook.async_unregister(hass, entry.data[CONF_WEBHOOK])
    data: WTData = hass.data.pop(DOMAIN)
    data.unload()
    await hass.async_add_executor_job(data.store.close)
    for svc in ("log_weight", "log_water", "log_bp", "log_note", "log_steps", "quick_add", "send_summary", "ingest"):
        hass.services.async_remove(DOMAIN, svc)
    return ok


def _register_services(hass: HomeAssistant, data: WTData) -> None:
    async def log_weight(call: ServiceCall):
        day, ts = data.parse_ts(call.data.get("when"))
        w = call.data["weight"]
        if call.data.get("unit") == "kg":
            w *= 2.20462
        await data.run(data.store.add_weight, day, ts, round(w, 1), call.data.get("body_fat"),
                       call.data.get("source", "manual"))
        await data.async_refresh()

    async def log_water(call: ServiceCall):
        day, ts = data.parse_ts(call.data.get("when"))
        await data.run(data.store.add_water, day, ts, call.data["oz"], "service")
        await data.async_refresh()

    async def log_steps(call: ServiceCall):
        day, ts = data.parse_ts(call.data.get("when"))
        await data.run(data.store.set_steps, day, ts, call.data["steps"], call.data.get("source", "healthsync"))
        await data.async_refresh()

    async def log_bp(call: ServiceCall):
        day, ts = data.parse_ts(call.data.get("when"))
        await data.run(data.store.add_bp, day, ts, call.data["systolic"], call.data["diastolic"],
                       call.data.get("pulse"), "manual", call.data.get("note"))
        await data.async_refresh()

    async def log_note(call: ServiceCall):
        day, ts = data.parse_ts(call.data.get("when"))
        await data.run(data.store.add_note, day, ts, call.data["text"], call.data.get("tag"))
        await data.async_refresh()

    async def quick_add(call: ServiceCall):
        day, ts = data.parse_ts(call.data.get("when"))
        direct = {k: call.data.get(k) for k in NUT}
        direct["name"] = call.data.get("name") or "Quick add"
        await data.run(data.store.add_entry, day, call.data["meal"], ts, None, 1, None, None, direct, "service")
        await data.async_refresh()

    async def send_summary(call: ServiceCall):
        await data.reminder("summary")

    async def ingest(call: ServiceCall) -> ServiceResponse:
        return await data.ingest(dict(call.data), call.data.get("source", "shortcut"))

    when = vol.Optional("when")
    hass.services.async_register(DOMAIN, "log_weight", log_weight, vol.Schema({
        vol.Required("weight"): vol.Coerce(float), vol.Optional("unit", default="lb"): vol.In(["lb", "kg"]),
        vol.Optional("body_fat"): vol.Coerce(float), vol.Optional("source"): cv.string, when: cv.string}))
    hass.services.async_register(DOMAIN, "log_water", log_water, vol.Schema({
        vol.Required("oz"): vol.Coerce(float), when: cv.string}))
    hass.services.async_register(DOMAIN, "log_steps", log_steps, vol.Schema({
        vol.Required("steps"): vol.Coerce(int), vol.Optional("source"): cv.string, when: cv.string}))
    hass.services.async_register(DOMAIN, "log_bp", log_bp, vol.Schema({
        vol.Required("systolic"): vol.Coerce(int), vol.Required("diastolic"): vol.Coerce(int),
        vol.Optional("pulse"): vol.Coerce(int), vol.Optional("note"): cv.string, when: cv.string}))
    hass.services.async_register(DOMAIN, "log_note", log_note, vol.Schema({
        vol.Required("text"): cv.string, vol.Optional("tag"): cv.string, when: cv.string}))
    hass.services.async_register(DOMAIN, "quick_add", quick_add, vol.Schema({
        vol.Required("meal"): vol.In(MEALS), vol.Required("kcal"): vol.Coerce(float),
        vol.Optional("name"): cv.string, **{vol.Optional(k): vol.Coerce(float) for k in NUT if k != "kcal"},
        when: cv.string}))
    hass.services.async_register(DOMAIN, "send_summary", send_summary)
    hass.services.async_register(DOMAIN, "ingest", ingest, vol.Schema({}, extra=vol.ALLOW_EXTRA),
                                 supports_response=SupportsResponse.OPTIONAL)
