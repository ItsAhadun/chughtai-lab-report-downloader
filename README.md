# Chughtai Lab Report Downloader

Chrome extension that bulk-downloads patient reports from the
[Chughtai Lab patient dashboard](https://chughtailab.com/patient-dashboard/).

## Install

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.

## Use

1. Log in at <https://chughtailab.com/patient-dashboard/> as usual.
2. Pick a patient in the site's **Select Patient** dropdown.
3. Use the **Report Downloader** panel (bottom-right corner):
   - **Download all reports (selected patient)** — grabs every available report
     and invoice for that patient, across all cases.
   - Or type a case number (e.g. `50211-18-06`, partial numbers work) and click
     **Download case** to get just that case.

Everything is bundled into **one ZIP file**, so you only get a single save
prompt:

```
Chughtai Lab - <PATIENT NAME> (<patient id>).zip
  <case number> - <date> - <test name>.pdf
  ...
```

(For a single case the ZIP is named `… - Case <case number>.zip`.)

## Notes

- The extension asks the site for the patient's report list the same way the
  dashboard itself does (via `admin-ajax.php`), so you must be logged in.
- The report PDFs are fetched in the background and zipped in memory; the
  panel shows progress while it works.
- All tests inside one case share a single report PDF (a bundle), so you get
  one report file per case — duplicates are skipped.
- Invoices are ignored; only test reports are downloaded.
- Tests whose reports aren't ready yet have no download link and are skipped.
- If the report server returns an error page instead of a PDF for some file,
  that file is skipped and counted as failed in the status message.
