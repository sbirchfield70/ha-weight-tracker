"""Constants for Weight Tracker."""
DOMAIN = "weight_tracker"
SIGNAL_UPDATE = "weight_tracker_update"
DB_FILE = "weight_tracker.db"
DEFAULT_FOOD_DB = "http://192.168.1.50:8080"  # your food database server (see fooddb/)
CONF_FOOD_DB = "food_db_url"
CONF_WEBHOOK = "webhook_id"
DASHBOARD_URL = "/weight-tracker/today"

NUT = ["kcal", "protein", "carbs", "fat", "sat_fat", "fiber", "sugar", "sodium_mg", "chol_mg"]
MEALS = ["breakfast", "lunch", "dinner", "snacks"]

DEFAULT_SETTINGS = {
    "units": "lb",
    "start_weight": None,
    "start_date": None,
    "goal_weight": None,
    "height_in": None,
    "daily_kcal": 2000,
    "goals": {"protein": 150, "carbs": 200, "fat": 65, "fiber": 30, "sugar": 50,
              "sodium_mg": 2300, "sat_fat": 20, "chol_mg": 300},
    "water_goal_oz": 64,
    "notify_target": "both",          # off | dashboard | app | both
    "notify_service": "",               # picked in the card's Settings tab
    "over_goal_alert": True,
    "reminders": {
        "breakfast": {"enabled": True, "time": "10:00"},
        "lunch": {"enabled": True, "time": "14:00"},
        "dinner": {"enabled": True, "time": "20:00"},
        "weigh_in": {"enabled": True, "time": "09:00"},
        "water": {"enabled": False, "time": "15:00"},
        "summary": {"enabled": True, "time": "21:30"},
    },
}
