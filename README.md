# ham-helper-data

Callsign lookup data for the **Ham Helper** app. It's built automatically from the FCC's public **Universal Licensing System (ULS)** amateur radio files.

- **Source:** FCC ULS public database downloads, https://www.fcc.gov/uls/transactions/daily-weekly (`l_amat.zip` weekly, `l_am_<day>.zip` daily).
- **Contents:** active amateur licenses only, with callsign, licensee name, city, state, ZIP5, operator class, grant date and expiry date.
  - **No street addresses, PO boxes or FRNs** are read or published. No license history is included.
- **Where it lives:** release [`current`](../../releases/tag/current), with `manifest.json`, `full-YYYYMMDD.hhc.gz` and `delta-YYYYMMDD.hhc.gz`. Each file is listed in the manifest with its byte size and sha256.
- **Schedule** (`.github/workflows/uls.yml`):
  - Daily at 13:30 UTC: a delta built from the FCC daily file.
  - Sundays: a full rebuild from the FCC weekly file, plus a reconcile delta, so clients keep updating via deltas (a 35-day rolling chain).
- **Format:** HHC1, a gzip-compressed columnar format. The decoder is `pipeline/lib/format.ts`.
- **Approx. grid:** clients derive an approximate 4-character Maidenhead grid from the ZIP centroid, using the U.S. Census Bureau 2024 Gazetteer ZCTA file (public domain).

## Removal requests
To have your callsign left out of this dataset, email **support@shiverlogic.com** with the subject "Callsign removal". Requests are handled within 7 days by adding the call to `pipeline/suppress.txt`. It's removed from the next build, and from installed apps via the next delta.

Your record stays public at the FCC. To change what the FCC publishes, update your license in ULS (https://www.fcc.gov/uls).

See [LICENSE](LICENSE).
