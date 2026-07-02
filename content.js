(() => {
  'use strict';

  const AJAX_URL = 'https://chughtailab.com/wp-admin/admin-ajax.php';

  // ---------- fetching & parsing ----------

  async function fetchReportsHtml(patientId) {
    const res = await fetch(AJAX_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      credentials: 'include',
      body: new URLSearchParams({
        action: 'get_patient_reports_ajax',
        patient_id: patientId,
      }),
    });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const json = await res.json();
    if (!json.success || !json.data || !json.data.html) {
      throw new Error('No reports returned for this patient.');
    }
    return json.data.html;
  }

  // Each case is a .card: header holds "Case Number: <no>" and a date,
  // body rows hold test names and download links. All tests of a case share
  // one report bundle URL, so links are deduped by URL.
  function parseCases(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const cases = [];
    doc.querySelectorAll('.card').forEach((card) => {
      const headings = card.querySelector('.report-headings');
      if (!headings) return;
      let caseNo = '';
      let date = '';
      headings.querySelectorAll('p').forEach((p) => {
        const text = p.textContent.replace(/\s+/g, ' ').trim();
        if (text.startsWith('Case Number:')) {
          caseNo = text.replace('Case Number:', '').trim();
        } else if (!date && text) {
          date = text;
        }
      });
      const files = [];
      const byUrl = new Map();
      card.querySelectorAll('.card-body .row').forEach((row) => {
        const link = row.querySelector('a.downloadBtn');
        if (!link || !link.href) return;
        const label = (row.querySelector('.pDetail p')?.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();
        // Invoices are labelled "Invoice" and use a ?p= link (reports use ?bdl=)
        const isInvoice = /^invoice$/i.test(label) || /[?&]p=/.test(link.href);
        const existing = byUrl.get(link.href);
        if (existing) {
          if (!isInvoice && label) existing.tests.push(label);
          return;
        }
        const entry = {
          url: link.href,
          isInvoice,
          tests: !isInvoice && label ? [label] : [],
        };
        byUrl.set(link.href, entry);
        files.push(entry);
      });
      cases.push({ caseNo, date, files });
    });
    return cases;
  }

  // ---------- filenames ----------

  function sanitize(part) {
    return part
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100);
  }

  function buildEntryName(caze, file) {
    let name;
    if (file.tests.length === 0) name = 'Report';
    else if (file.tests.length === 1) name = file.tests[0];
    else name = `${file.tests[0]} +${file.tests.length - 1} more`;
    const parts = [caze.caseNo, caze.date, name].filter(Boolean).map(sanitize);
    return `${parts.join(' - ')}.pdf`;
  }

  // ---------- downloading ----------

  function downloadZip(zipName, files) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'download-zip', zipName, files }, (resp) => {
        resolve(resp || { ok: false, error: chrome.runtime.lastError?.message || 'No response' });
      });
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'zip-progress') return;
    if (msg.phase === 'fetch') setStatus(`Fetching file ${msg.done} of ${msg.total}…`);
    else if (msg.phase === 'zip') setStatus('Zipping files…');
  });

  async function downloadReports(caseFilter) {
    const select = document.querySelector('#patient_id');
    if (!select) {
      setStatus('Patient dropdown not found — make sure you are logged in.');
      return;
    }
    const patientId = select.value;
    if (!patientId) {
      setStatus('Pick a patient in the "Select Patient" dropdown first.');
      return;
    }
    const patientName = select.options[select.selectedIndex].text.trim();
    const patientLabel = `${patientName} (${patientId})`;

    setStatus('Fetching report list…');
    const html = await fetchReportsHtml(patientId);
    let cases = parseCases(html);

    if (caseFilter) {
      const wanted = caseFilter.replace(/\s+/g, '');
      cases = cases.filter((c) => c.caseNo.replace(/\s+/g, '').includes(wanted));
      if (cases.length === 0) {
        setStatus(`No case matching "${caseFilter}" found for ${patientName}.`);
        return;
      }
    }

    const files = [];
    for (const c of cases) {
      for (const f of c.files) {
        if (f.isInvoice) continue; // reports only — skip invoices
        files.push({ url: f.url, name: buildEntryName(c, f) });
      }
    }
    if (files.length === 0) {
      setStatus('No downloadable reports found (reports may still be pending).');
      return;
    }

    const zipName = sanitize(
      caseFilter
        ? `Chughtai Lab - ${patientLabel} - Case ${cases[0].caseNo}`
        : `Chughtai Lab - ${patientLabel}`
    ) + '.zip';

    setStatus(`Fetching ${files.length} file(s)…`);
    const resp = await downloadZip(zipName, files);
    if (!resp.ok) {
      setStatus(`Error: ${resp.error}`);
      return;
    }
    setStatus(
      `Done — ${resp.count} file(s) zipped into ${zipName}` +
        (resp.failed && resp.failed.length ? ` (${resp.failed.length} failed)` : '') +
        '.'
    );
  }

  // ---------- UI panel ----------

  let statusEl;

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'cld-panel';
    panel.innerHTML = `
      <div id="cld-title">Report Downloader</div>
      <button id="cld-all" type="button">Download all reports (selected patient)</button>
      <div id="cld-case-row">
        <input id="cld-case-input" type="text" placeholder="Case number e.g. 50211-18-06">
        <button id="cld-case" type="button">Download case</button>
      </div>
      <div id="cld-status">Select a patient, then download.</div>
    `;
    document.body.appendChild(panel);
    statusEl = panel.querySelector('#cld-status');

    const allBtn = panel.querySelector('#cld-all');
    const caseBtn = panel.querySelector('#cld-case');
    const caseInput = panel.querySelector('#cld-case-input');

    async function run(caseFilter) {
      allBtn.disabled = true;
      caseBtn.disabled = true;
      try {
        await downloadReports(caseFilter);
      } catch (err) {
        setStatus(`Error: ${err.message}`);
      } finally {
        allBtn.disabled = false;
        caseBtn.disabled = false;
      }
    }

    allBtn.addEventListener('click', () => run(null));
    caseBtn.addEventListener('click', () => {
      const value = caseInput.value.trim();
      if (!value) {
        setStatus('Type a case number first.');
        return;
      }
      run(value);
    });
  }

  buildPanel();
})();
