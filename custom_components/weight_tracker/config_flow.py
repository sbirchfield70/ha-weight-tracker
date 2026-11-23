"""Config flow for Weight Tracker."""
from __future__ import annotations

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback

from .const import CONF_FOOD_DB, DEFAULT_FOOD_DB, DOMAIN


class WTConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        if user_input is not None:
            return self.async_create_entry(title="Weight Tracker", data=user_input)
        return self.async_show_form(step_id="user", data_schema=vol.Schema(
            {vol.Required(CONF_FOOD_DB, default=DEFAULT_FOOD_DB): str}))

    @staticmethod
    @callback
    def async_get_options_flow(entry):
        return WTOptionsFlow()


class WTOptionsFlow(config_entries.OptionsFlow):
    async def async_step_init(self, user_input=None):
        if user_input is not None:
            return self.async_create_entry(data=user_input)
        cur = self.config_entry.options.get(CONF_FOOD_DB) or self.config_entry.data.get(CONF_FOOD_DB, DEFAULT_FOOD_DB)
        return self.async_show_form(step_id="init", data_schema=vol.Schema(
            {vol.Required(CONF_FOOD_DB, default=cur): str}))
