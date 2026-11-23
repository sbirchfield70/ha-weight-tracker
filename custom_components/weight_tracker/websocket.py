"""Websocket API used by the weight-tracker-card."""
from __future__ import annotations

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect

from .const import CONF_FOOD_DB, CONF_WEBHOOK, DEFAULT_FOOD_DB, DOMAIN, MEALS, NUT, SIGNAL_UPDATE

DATE = vol.Match(r"^\d{4}-\d{2}-\d{2}$")
_registered = False


def _d(hass):
    return hass.data[DOMAIN]


def _cmd(schema, fn):
    """Wrap an async handler(data, msg) -> result."""

    @websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/{schema.pop('_t')}", **schema})
    @websocket_api.async_response
    async def handler(hass, connection, msg):
        if DOMAIN not in hass.data:
            connection.send_error(msg["id"], "not_ready", "Weight Tracker is not loaded")
            return
        try:
            res = await fn(_d(hass), msg)
        except (ValueError, vol.Invalid) as e:
            connection.send_error(msg["id"], "invalid", str(e))
            return
        connection.send_result(msg["id"], res)

    return handler


async def _changed(d, res=None):
    await d.async_refresh()
    return res if res is not None else {"ok": True}


# ---------------- handlers
async def h_day(d, m):
    day = m.get("date") or d.today()
    res = await d.run(d.store.day, day)
    res["today"] = d.today()
    res["settings"] = d.summary.get("settings")
    res["summary"] = d.summary
    res["alerts"] = d.alerts
    return res


async def h_range(d, m):
    return await d.run(d.store.range, m["start"], m["end"])


async def h_settings_get(d, m):
    s = await d.run(d.store.settings)
    base = d.hass.config.external_url or d.hass.config.internal_url or ""
    try:
        from homeassistant.helpers.network import get_url
        base = get_url(d.hass, prefer_external=True, allow_cloud=True)
    except Exception:  # noqa: BLE001
        pass
    notify = sorted(s_ for s_ in d.hass.services.async_services().get("notify", {}) if s_.startswith("mobile_app"))
    return {"settings": s, "webhook_url": f"{base.rstrip('/')}/api/webhook/{d.entry.data[CONF_WEBHOOK]}",
            "notify_services": notify,
            "food_db_url": d.food_db, "food_db": await d.food_db_health()}


async def h_settings_set(d, m):
    s = await d.run(d.store.set_settings, m["settings"])
    await d.async_refresh()
    d.schedule()
    return {"settings": s}


async def h_search(d, m):
    return await d.search(m["q"])


async def h_barcode(d, m):
    return await d.barcode(m["code"])


async def h_recent(d, m):
    return {"products": await d.run(d.store.recent_foods, m.get("limit", 40))}


async def h_food_save(d, m):
    return {"food": await d.run(d.store.save_custom_food, m["food"], d.ts())}


async def h_food_delete(d, m):
    await d.run(d.store.delete_food, m["food_id"])
    return {"ok": True}


async def h_food_fav(d, m):
    await d.run(d.store.set_favorite, m["food"], m["favorite"], d.ts())
    return {"ok": True}


async def h_entry_add(d, m):
    day = m.get("date") or d.today()
    ts = d.ts() if day == d.today() else f"{day}T12:00:00"
    food = m.get("food")
    eid = await d.run(d.store.add_entry, day, m["meal"], ts, food, m.get("amount", 1),
                      m.get("portion_label"), m.get("portion_g"), m.get("direct"), "manual")
    if food and food.get("id"):
        await d.run(d.store.remember_food, food, m.get("amount", 1), m.get("portion_label"), d.ts())
    return await _changed(d, {"id": eid})


async def h_entry_update(d, m):
    await d.run(d.store.update_entry, m["entry_id"], m.get("amount"), m.get("portion_label"), m.get("portion_g"),
                m.get("meal"), m.get("date"), m.get("direct"))
    return await _changed(d)


async def h_entry_delete(d, m):
    await d.run(d.store.delete_entry, m["entry_id"])
    return await _changed(d)


async def h_copy_meal(d, m):
    n = await d.run(d.store.copy_meal, m["from_date"], m["meal"], m["to_date"], m.get("to_meal"), d.ts())
    return await _changed(d, {"copied": n})


def _when(d, m):
    if m.get("ts"):
        return d.parse_ts(m["ts"])
    day = m.get("date") or d.today()
    return (day, d.ts()) if day == d.today() else (day, f"{day}T12:00:00")


async def h_water(d, m):
    day, ts = _when(d, m)
    await d.run(d.store.add_water, day, ts, m["oz"], "manual")
    return await _changed(d)


async def h_weight(d, m):
    day, ts = _when(d, m)
    await d.run(d.store.add_weight, day, ts, m["weight"], m.get("body_fat"), "manual")
    return await _changed(d)


async def h_bp(d, m):
    day, ts = _when(d, m)
    await d.run(d.store.add_bp, day, ts, m["systolic"], m["diastolic"], m.get("pulse"), "manual", m.get("note"))
    return await _changed(d)


async def h_note(d, m):
    day, ts = _when(d, m)
    await d.run(d.store.add_note, day, ts, m["text"], m.get("tag"))
    return await _changed(d)


async def h_delete(d, m):
    await d.run(d.store.delete_row, m["table"], m["row_id"])
    return await _changed(d)


async def h_history(d, m):
    return {"rows": await d.run(d.store.history, m["kind"], m.get("limit", 60))}


async def h_dismiss(d, m):
    d.dismiss_alert(m.get("kind"))
    return {"ok": True}


async def h_test_notify(d, m):
    await d.notify("test", "Weight Tracker", "Test notification: this is how reminders will look.")
    return {"ok": True}


NUM = vol.Coerce(float)
COMMANDS = [
    ({"_t": "day", vol.Optional("date"): DATE}, h_day),
    ({"_t": "range", vol.Required("start"): DATE, vol.Required("end"): DATE}, h_range),
    ({"_t": "settings/get"}, h_settings_get),
    ({"_t": "settings/set", vol.Required("settings"): dict}, h_settings_set),
    ({"_t": "food/search", vol.Required("q"): str}, h_search),
    ({"_t": "food/barcode", vol.Required("code"): str}, h_barcode),
    ({"_t": "food/recent", vol.Optional("limit"): int}, h_recent),
    ({"_t": "food/save", vol.Required("food"): dict}, h_food_save),
    ({"_t": "food/delete", vol.Required("food_id"): str}, h_food_delete),
    ({"_t": "food/favorite", vol.Required("food"): dict, vol.Required("favorite"): bool}, h_food_fav),
    ({"_t": "entry/add", vol.Optional("date"): DATE, vol.Required("meal"): vol.In(MEALS),
      vol.Optional("food"): vol.Any(dict, None), vol.Optional("amount"): NUM,
      vol.Optional("portion_label"): vol.Any(str, None), vol.Optional("portion_g"): vol.Any(NUM, None),
      vol.Optional("direct"): vol.Any(dict, None)}, h_entry_add),
    ({"_t": "entry/update", vol.Required("entry_id"): int, vol.Optional("amount"): NUM,
      vol.Optional("portion_label"): vol.Any(str, None), vol.Optional("portion_g"): vol.Any(NUM, None),
      vol.Optional("meal"): vol.In(MEALS), vol.Optional("date"): DATE,
      vol.Optional("direct"): vol.Any(dict, None)}, h_entry_update),
    ({"_t": "entry/delete", vol.Required("entry_id"): int}, h_entry_delete),
    ({"_t": "entry/copy_meal", vol.Required("from_date"): DATE, vol.Required("meal"): vol.In(MEALS),
      vol.Required("to_date"): DATE, vol.Optional("to_meal"): vol.In(MEALS)}, h_copy_meal),
    ({"_t": "water/add", vol.Required("oz"): NUM, vol.Optional("date"): DATE, vol.Optional("ts"): str}, h_water),
    ({"_t": "weight/add", vol.Required("weight"): NUM, vol.Optional("body_fat"): vol.Any(NUM, None),
      vol.Optional("date"): DATE, vol.Optional("ts"): str}, h_weight),
    ({"_t": "bp/add", vol.Required("systolic"): vol.Coerce(int), vol.Required("diastolic"): vol.Coerce(int),
      vol.Optional("pulse"): vol.Any(vol.Coerce(int), None), vol.Optional("note"): vol.Any(str, None),
      vol.Optional("date"): DATE, vol.Optional("ts"): str}, h_bp),
    ({"_t": "note/add", vol.Required("text"): str, vol.Optional("tag"): vol.Any(str, None),
      vol.Optional("date"): DATE, vol.Optional("ts"): str}, h_note),
    ({"_t": "delete", vol.Required("table"): vol.In(["water", "weights", "bp", "notes"]),
      vol.Required("row_id"): int}, h_delete),
    ({"_t": "history", vol.Required("kind"): vol.In(["weights", "bp", "notes"]), vol.Optional("limit"): int},
     h_history),
    ({"_t": "alerts/dismiss", vol.Optional("kind"): vol.Any(str, None)}, h_dismiss),
    ({"_t": "notify/test"}, h_test_notify),
]


@callback
def async_register(hass: HomeAssistant) -> None:
    global _registered
    if _registered:
        return
    _registered = True
    for schema, fn in COMMANDS:
        websocket_api.async_register_command(hass, _cmd(dict(schema), fn))
    websocket_api.async_register_command(hass, ws_subscribe)


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/subscribe"})
@callback
def ws_subscribe(hass, connection, msg):
    """Push {'changed': true} whenever data changes."""

    @callback
    def _fwd():
        connection.send_message(websocket_api.event_message(msg["id"], {"changed": True}))

    connection.subscriptions[msg["id"]] = async_dispatcher_connect(hass, SIGNAL_UPDATE, _fwd)
    connection.send_result(msg["id"])
