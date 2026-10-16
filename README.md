# ham-helper-data

Callsign lookup data for the **Ham Helper** app. It's built automatically from the FCC's public **Universal Licensing System (ULS)** amateur radio files.

- **Source:** FCC ULS public database downloads, https://www.fcc.gov/uls/transactions/daily-weekly (`l_amat.zip` weekly, `l_am_<day>.zip` daily).
- **Contents:** active amateur licenses only, with callsign, licensee name, city, state, ZIP5, operator class, grant date and expiry date.
  - **No street addresses, PO boxes or FRNs** are read or published. No license history is included. The FCC *city* field is cleaned to a city name only (some licensees typed addresses there), and the build fails if any address-like value survives.
  - Licenses past the FCC's 2-year renewal grace period are excluded.
- **Where it lives:** release [`current`](../../releases/tag/current), with `manifest.json`, `full-YYYYMMDD.hhc.gz` and `delta-YYYYMMDD.hhc.gz`. Each file is listed in the manifest with its byte size and sha256.
- **Schedule** (`.github/workflows/uls.yml`):
  - Daily at 15:30 UTC: a delta built from yesterday's FCC daily file (`l_am_<day>.zip` is posted the morning after).
  - Sundays: a full rebuild from the FCC weekly file, plus a reconcile delta, so clients keep updating via deltas (a 35-day rolling chain).
- **Integrity:** `manifest.json` is an Ed25519-signed envelope (`payload` + `sig`, key id `hh1`). Public key (base64, raw 32 bytes): `0aw435wpAZwjIFP3R7AIC39U+npzpQqynygHHK7FBuc=`. Each file is listed in the payload with its size and sha256. Version stamps are the FCC file's Last-Modified time (UTC, YYYYMMDDHHMM).
- **Freshness:** a source file is only processed if its HTTP `Last-Modified` is newer than every source already processed (`sources.json`). Otherwise the run publishes nothing. Older license records never overwrite newer ones.
- **Operator class:** FCC AM record position 6 (T Technician, G General, A Advanced, E Extra, N Novice, P Technician Plus), joined on unique_system_identifier. It is blank for club, military and RACES stations.
- **Format:** HHC2, a gzip-compressed columnar format in 20,000-row blocks (streamable). The decoder is `pipeline/lib/format.ts`.
- **Approx. grid:** clients derive an approximate 4-character Maidenhead grid from the ZIP centroid, using the U.S. Census Bureau 2024 Gazetteer ZCTA file (public domain).

## Removal requests
To have your callsign removed from this dataset, email **support@shiverlogic.com** with the subject "Callsign removal" and include your callsign. We may ask you to confirm that you hold the license. Once confirmed, the record is excluded from the next data build, and installed apps remove it at their next update. No removal list is published in this repository.

Your record stays public at the FCC. To change what the FCC publishes, update your license in ULS (https://www.fcc.gov/uls).

See [LICENSE](LICENSE).
