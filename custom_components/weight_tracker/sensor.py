"""Weight Tracker sensors."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.core import callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect

from .const import DOMAIN, SIGNAL_UPDATE


@dataclass
class Desc:
    key: str
    name: str
    unit: str | None
    icon: str
    value: Callable[[dict], Any]
    attrs: Callable[[dict], dict] | None = None
    state_class: SensorStateClass | None = SensorStateClass.MEASUREMENT
    device_class: SensorDeviceClass | None = None


def _t(k):
    return lambda s: (s.get("totals") or {}).get(k)


def _goal(k):
    return lambda s: {"goal": ((s.get("settings") or {}).get("goals") or {}).get(k)}


DESCS = [
    Desc("calories_today", "Calories today", "kcal", "mdi:food-apple", _t("kcal"),
         lambda s: {"goal": (s.get("settings") or {}).get("daily_kcal"), **{f"{m}_kcal": v for m, v in
                                                                          (s.get("meal_kcal") or {}).items()}}),
    Desc("calories_remaining", "Calories remaining", "kcal", "mdi:fire",
         lambda s: round(((s.get("settings") or {}).get("daily_kcal") or 0) - ((s.get("totals") or {}).get("kcal") or 0))),
    Desc("calories_7_day_average", "Calories 7-day average", "kcal", "mdi:chart-bar", lambda s: s.get("kcal_avg_7d")),
    Desc("protein_today", "Protein today", "g", "mdi:food-drumstick", _t("protein"), _goal("protein")),
    Desc("carbs_today", "Carbs today", "g", "mdi:bread-slice", _t("carbs"), _goal("carbs")),
    Desc("fat_today", "Fat today", "g", "mdi:oil", _t("fat"), _goal("fat")),
    Desc("fiber_today", "Fiber today", "g", "mdi:leaf", _t("fiber"), _goal("fiber")),
    Desc("sugar_today", "Sugar today", "g", "mdi:candy", _t("sugar"), _goal("sugar")),
    Desc("sodium_today", "Sodium today", "mg", "mdi:shaker", _t("sodium_mg"), _goal("sodium_mg")),
    Desc("water_today", "Water today", "fl. oz.", "mdi:cup-water", lambda s: s.get("water_oz"),
         lambda s: {"goal": (s.get("settings") or {}).get("water_goal_oz")}, device_class=SensorDeviceClass.VOLUME),
    Desc("weight", "Weight", "lb", "mdi:scale-bathroom", lambda s: s.get("weight"),
         lambda s: {"measured": s.get("weight_ts"), "change_7d": s.get("weight_change_7d"),
                    "goal_weight": s.get("goal_weight"), "start_weight": s.get("start_weight"),
                    "to_goal": s.get("to_goal"), "lost": s.get("lost"), "bmi": s.get("bmi"),
                    "body_fat": s.get("body_fat")}, device_class=SensorDeviceClass.WEIGHT),
    Desc("weight_to_goal", "Weight to goal", "lb", "mdi:flag-checkered", lambda s: s.get("to_goal"),
         device_class=SensorDeviceClass.WEIGHT),
    Desc("blood_pressure", "Blood pressure", None, "mdi:heart-pulse",
         lambda s: f"{s['bp']['systolic']}/{s['bp']['diastolic']}" if s.get("bp") else None,
         lambda s: dict(s.get("bp") or {}), state_class=None),
    Desc("systolic", "Systolic", "mmHg", "mdi:heart-pulse", lambda s: (s.get("bp") or {}).get("systolic"),
         device_class=SensorDeviceClass.PRESSURE),
    Desc("diastolic", "Diastolic", "mmHg", "mdi:heart-pulse", lambda s: (s.get("bp") or {}).get("diastolic"),
         device_class=SensorDeviceClass.PRESSURE),
]


async def async_setup_entry(hass, entry, async_add_entities):
    data = hass.data[DOMAIN]
    async_add_entities([WTSensor(data, entry, d) for d in DESCS])


class WTSensor(SensorEntity):
    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, data, entry, desc: Desc) -> None:
        self._data, self._desc = data, desc
        self._attr_unique_id = f"{entry.entry_id}_{desc.key}"
        self._attr_name = desc.name
        self._attr_native_unit_of_measurement = desc.unit
        self._attr_icon = desc.icon
        self._attr_state_class = desc.state_class
        self._attr_device_class = desc.device_class
        if desc.device_class == SensorDeviceClass.PRESSURE:
            self._attr_suggested_display_precision = 0
        self._attr_device_info = DeviceInfo(identifiers={(DOMAIN, entry.entry_id)}, name="Weight Tracker",
                                            manufacturer="Home", model="Nutrition & weight log")

    @property
    def native_value(self):
        return self._desc.value(self._data.summary or {})

    @property
    def extra_state_attributes(self):
        return self._desc.attrs(self._data.summary or {}) if self._desc.attrs else None

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(async_dispatcher_connect(self.hass, SIGNAL_UPDATE, self._upd))

    @callback
    def _upd(self) -> None:
        self.async_write_ha_state()
