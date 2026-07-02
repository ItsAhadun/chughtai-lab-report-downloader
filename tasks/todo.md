# Chughtai Lab Report Downloader — Chrome Extension

## Findings (from saved dashboard HTML)

- Page: `https://chughtailab.com/patient-dashboard/` (WordPress).
- Patient list: `<select id="patient_id">` — option value = patient ID, text = name.
- Reports are fetched via `POST https://chughtailab.com/wp-admin/admin-ajax.php`
  with `action=get_patient_reports_ajax&patient_id=<id>` → JSON `{success, data:{html}}`.
- In the returned HTML each case is a `.card`; header `.report-headings` holds
  `Case Number: <no>` and a date; body rows hold test names (`.pDetail p`) and
  download links `a.downloadBtn` → `https://reports.chughtailab.com/ReportViewer.aspx?bdl=…`
  (report bundle, shared by all tests of a case) or `?p=…` (invoice).

## Plan

- [x] manifest.json — MV3, content script on patient-dashboard, `downloads` permission
- [x] content.js — inject panel, fetch + parse report list, send download jobs
- [x] background.js — service worker, chrome.downloads.download with folder/filename
- [x] panel.css — panel styling
- [x] README.md — install + usage
- [x] Verify: static checks (JSON valid, JS syntax) — full manual test requires a
      logged-in dashboard session, which only the user has

## v2: single ZIP download (user feedback: one save prompt per file was annoying)

- [x] background.js — fetch all PDFs (host_permissions on reports.chughtailab.com),
      build ZIP in memory (store method, minimal writer, no libraries), one
      chrome.downloads.download via data: URL → one save prompt
- [x] content.js — send one download-zip job, show fetch/zip progress from
      background via tabs.sendMessage
- [x] Verify: buildZip output expands correctly with Windows Expand-Archive
      (names, content, empty-file and duplicate-name edge cases); base64
      data-URL round-trip byte-exact; JS syntax OK

## v3: skip invoices (user feedback: invoices are unwanted noise in the zip)

- [x] content.js — filter out invoice entries before building the zip job;
      invoice detection uses both the "Invoice" row label and the ?p= URL
      pattern (reports use ?bdl=)

## v4: multi-patient selection (user feedback: dropdown has duplicate
## registrations of the same people; want all their files at once)

- [x] content.js — patient checklist in the panel (from the page's #patient_id
      options, IDs shown), select-all toggle; downloads iterate checked
      patients; per-patient folders inside the zip when >1 checked
- [x] panel.css — checklist styling
- [x] manifest.json — version 1.1.0
- [x] Verify: browser test against saved dashboard HTML with stubbed
      chrome.runtime + AJAX — 10 checkboxes rendered, 2-patient run produced
      28 files in 2 folders with no invoice URLs, select-all + case filter
      produced 10 files, zero-selection shows a message
- [x] GitHub release with ready-to-install zip

## Review

- Extension is self-contained (no libraries). One ZIP per download action:
  `Chughtai Lab - <patient>.zip` containing `<case> - <date> - <name>.pdf`.
- Duplicate bundle URLs within a case are deduped, so one PDF per case + invoice.
- Files whose response looks like HTML (error page) are skipped and reported
  as failed.

## Lessons

- chrome.downloads.download prompts per file when Chrome's "ask where to save
  each file" is on — for bulk downloads, zip in the service worker and issue a
  single download instead.
