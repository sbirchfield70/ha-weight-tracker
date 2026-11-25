# Apple Health sync

Home Assistant can't read Apple Health directly, but an iOS Shortcut can. It reads your recent weight and blood-pressure samples and posts them to the Weight Tracker's webhook. Any scale, cuff or app that writes to Apple Health works this way.

The webhook URL is on the card's **Health** tab. **Keep it private:** anyone who has it can add readings. The Shortcut needs to reach Home Assistant, so use your external URL (Nabu Casa, or your own) if you want it to work away from home.

Readings are de-duplicated by their time, so running the Shortcut again, or reading the same samples twice, never creates duplicates.

## 1. Let your scale write to Health

In your scale's app, turn on writing **Weight** to Apple Health. Do the same for a blood-pressure cuff.

## 2. Create the "Sync Health to Home" Shortcut

In the Shortcuts app, tap **+**. Find each action by typing its name in the search field.

1. **Find Health Samples**: Type is **Weight**, Start Date is in the last **7 days**, Sort by Start Date, **Latest First**, Limit **10**.
2. **Set Variable**: name it `Weights`.
3. **Find Health Samples**: Type is **Blood Pressure Systolic**, same filters. **Set Variable** `Systolic`.
4. **Find Health Samples**: Type is **Blood Pressure Diastolic**, same filters. **Set Variable** `Diastolic`.
5. **Get Contents of URL**: paste the webhook URL. Tap **Show More**: Method **POST**, Request Body **JSON**, and add these Text fields:

   | Key | Value |
   |---|---|
   | `weight` | `Weights` (tap the variable and choose **Value**) |
   | `weight_date` | `Weights` → **Start Date** |
   | `systolic` | `Systolic` → **Value** |
   | `diastolic` | `Diastolic` → **Value** |
   | `bp_date` | `Systolic` → **Start Date** |

Run it once by hand. iOS asks for permission to read Health data and to connect to your Home Assistant address; allow both. Your readings should show up on the Health tab.

**Backfill:** to bring in older readings once, temporarily change the filters to the last few years with no limit, run it, then change them back.

## 3. Run it automatically

Shortcuts → **Automation** → **+**:

- **Time of Day**, for example 8:00 AM and 9:00 PM daily, set to **Run Immediately**.
- **App** → your scale's app → **Is Closed**, set to **Run Immediately**, so a weigh-in shows up as soon as you close the app.

## 4. Optional: write calories and water back to Health

The webhook replies with today's totals: `kcal`, `protein`, `carbs`, `fat`, `fiber`, `sugar`, `sodium_mg`, `water_oz`, `weight` and `kcal_goal`.

Make a second Shortcut, **Log Food to Health**:

1. **Get Contents of URL**: the webhook URL, POST, JSON body with one field `sync` = `1`.
2. **Get Dictionary Value** `kcal` → **Log Health Sample**: Dietary Energy, in kcal.
3. **Get Dictionary Value** `water_oz` → **Log Health Sample**: Water, in fl oz (US).

Run it **once a day**, late in the evening (for example 11:55 PM), so the day's totals are only written once. If another food app also writes to Health, turn its access off so calories aren't counted twice.

## What the webhook accepts

A JSON (or form) body with any of these keys. Each value can be a single value, a list, or newline-separated text (that's what Shortcuts sends for a list of samples). Dates can be ISO, epoch seconds, or Shortcuts' own format like `Nov 3, 2025 at 7:30 AM`.

| Key | Meaning |
|---|---|
| `weight`, `weight_date`, `body_fat` | Weight in your chosen unit, its time, body fat % |
| `systolic`, `diastolic`, `pulse`, `bp_date` | Blood pressure reading and time |
| `water_oz` | Water to add |
| `note` | A note |

The `weight_tracker.ingest` action takes the same fields from automations.

## Alternative: HealthSync (no Shortcut)

If you'd rather not build a Shortcut, the [HealthSync](https://github.com/WeaveHubHQ/healthsync-ha) iOS app and its Home Assistant integration (HACS) push Apple Health data into sensors on their own. Two small automations then copy those sensors into the Weight Tracker. Replace `sensor.my_health_weight` and `sensor.my_health_steps_daily_total` with the sensor names HealthSync creates for you.

```yaml
# Weight: log each new reading at the time it was measured
alias: Weight Tracker - weight from HealthSync
mode: queued
triggers:
  - trigger: state
    entity_id: sensor.my_health_weight
    attribute: last_updated
conditions:
  - condition: template
    value_template: "{{ states('sensor.my_health_weight') | is_number }}"
actions:
  - action: weight_tracker.log_weight
    data:
      weight: "{{ states('sensor.my_health_weight') | float }}"
      unit: lb
      source: healthsync
      when: "{{ state_attr('sensor.my_health_weight', 'last_updated') }}"
```

```yaml
# Steps: keep the day's total up to date (shown on the Trends tab)
alias: Weight Tracker - steps from HealthSync
mode: queued
triggers:
  - trigger: state
    entity_id: sensor.my_health_steps_daily_total
conditions:
  - condition: template
    value_template: "{{ states('sensor.my_health_steps_daily_total') | is_number }}"
actions:
  - action: weight_tracker.log_steps
    data:
      steps: "{{ states('sensor.my_health_steps_daily_total') | int }}"
      source: healthsync
      when: "{{ state_attr('sensor.my_health_steps_daily_total', 'last_updated') or now().isoformat() }}"
```

Weights are de-duplicated by source and time, and steps keep one total per day, so resends are harmless.
