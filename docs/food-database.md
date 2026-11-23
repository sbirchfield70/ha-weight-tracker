# Food database server

`fooddb/` is a tiny read-only food lookup service. It uses only the Python standard library and a single SQLite file with full-text search, so there's nothing to `pip install`.

## Files

| File | Purpose |
|---|---|
| `update.py` | Downloads and loads the data (`update.py full` or `update.py nightly`) |
| `server.py` | The HTTP API on port 8080 |
| `fooddb-api.service` | Runs the API |
| `fooddb-update.service` + `.timer` | Runs `update.py nightly` at 03:15 |
| `install.sh` | Sets all of the above up under `/opt/fooddb` as user `fooddb` |

## Data

- **Open Food Facts**: the full product export (about 1.5 GB compressed), filtered to US products: those tagged `en:united-states`, or with a 13-digit barcode starting with 0 (a UPC). After the first load, the nightly run applies Open Food Facts' daily change files.
- **USDA FoodData Central**: Branded Foods, Foundation Foods and SR Legacy. The newest release file names are read from the USDA download page. Foundation and SR Legacy foods are "generic" foods (banana, chicken breast) and are ranked first in search.

A full rebuild is written to `fooddb.sqlite.new` and swapped in when it's finished, so lookups keep working during the rebuild. It runs on Sundays, when USDA publishes a new release, or if the database is missing.

Barcodes are normalized: 12-digit UPC-A codes get a leading 0 (EAN-13), and 14-digit codes with a leading 0 lose it.

Sodium and cholesterol values too large for any real food (contributors sometimes type milligrams into the grams field) are treated as milligrams.

## API

| Request | Returns |
|---|---|
| `GET /health` | Product counts per source and update times |
| `GET /barcode/<digits>` | Up to 6 matches; USDA label data first, then Open Food Facts |
| `GET /search?q=<text>&limit=25` | Full-text search, generic foods ranked up |
| `GET /food/<id>` | One product (`off:<barcode>` or `usda:<fdc_id>`) |

Each product has `name`, `brand`, `code`, `serving_label`, `serving_g`, `unit`, `portions` (label + grams) and `per100` with `kcal`, `protein`, `carbs`, `fat`, `sat_fat`, `fiber`, `sugar`, `sodium_mg` and `chol_mg` per 100 g (or 100 ml).

## Resources

- RAM: about 1.5 GB at peak during a full rebuild (the USDA nutrient table is pivoted inside SQLite to keep memory low). 2 GB is comfortable.
- Disk: about 800 MB for the database, plus downloads and a second copy during a rebuild. Allow 10 GB.
- A rebuild takes 30-60 minutes; a nightly update a minute or two.

## Other countries

Change `off_is_us()` in `update.py`, for example to check for `en:united-kingdom`, and run `sudo -u fooddb python3 /opt/fooddb/update.py full`. USDA data is US-only but still useful for generic foods.
