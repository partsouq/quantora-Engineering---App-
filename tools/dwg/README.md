# DWG worker

Uploaded DWG files are converted to a vector PDF (lines as lines, text as real text) so the normal
take-off reads them: tags, legends, schedules, symbols, routes.

- `worker.mjs`: claims queued DWG uploads from the `dwg-worker` function, converts, uploads, reports.
- `dwg2pdf.py`: draws the parsed DWG. One page per paper layout with content; model space on one A1
  page when there are no layouts.
- Runs on GitHub Actions (`.github/workflows/dwg-convert.yml`), started by the database the moment a DWG
  is uploaded, with a 5-minute schedule as a backup.

Licence: this folder is GPL-3.0-or-later because it uses LibreDWG (via `@mlightcad/libredwg-web`).
LibreDWG runs only on the build server. It is never shipped to users' browsers, and the main app does
not include or link it.
