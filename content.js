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

  // ---------- patients ----------

  function getPagePatients() {
    const select = document.querySelector('#patient_id');
    if (!select) return [];
    return Array.from(select.options)
      .filter((o) => o.value)
      .map((o) => ({ id: o.value, label: `${o.text.trim()} (${o.value})` }));
  }

  function getCheckedPatients() {
    return Array.from(
      document.querySelectorAll('#cld-patients input[type="checkbox"]:checked')
    ).map((cb) => ({ id: cb.value, label: cb.dataset.label }));
  }

  async function downloadReports(caseFilter) {
    const patients = getCheckedPatients();
    if (patients.length === 0) {
      setStatus('Tick at least one patient first.');
      return;
    }

    const files = [];
    const fetchErrors = [];
    let firstCaseNo = '';
    for (let i = 0; i < patients.length; i++) {
      const p = patients[i];
      setStatus(`Fetching report list ${i + 1} of ${patients.length} (${p.label})…`);
      let cases;
      try {
        cases = parseCases(await fetchReportsHtml(p.id));
      } catch (err) {
        fetchErrors.push(`${p.label}: ${err.message}`);
        continue;
      }
      if (caseFilter) {
        const wanted = caseFilter.replace(/\s+/g, '');
        cases = cases.filter((c) => c.caseNo.replace(/\s+/g, '').includes(wanted));
      }
      for (const c of cases) {
        if (!firstCaseNo && c.caseNo) firstCaseNo = c.caseNo;
        for (const f of c.files) {
          if (f.isInvoice) continue; // reports only — skip invoices
          const name = buildEntryName(c, f);
          // With several patients, give each their own folder inside the zip
          files.push({
            url: f.url,
            name: patients.length > 1 ? `${sanitize(p.label)}/${name}` : name,
          });
        }
      }
    }

    if (files.length === 0) {
      if (fetchErrors.length) setStatus(`Error: ${fetchErrors[0]}`);
      else if (caseFilter) setStatus(`No case matching "${caseFilter}" with downloadable reports found.`);
      else setStatus('No downloadable reports found (reports may still be pending).');
      return;
    }

    const base =
      patients.length === 1
        ? `Chughtai Lab - ${patients[0].label}`
        : `Chughtai Lab - ${patients.length} patients`;
    const zipName = sanitize(caseFilter ? `${base} - Case ${firstCaseNo}` : base) + '.zip';

    setStatus(`Fetching ${files.length} file(s)…`);
    const resp = await downloadZip(zipName, files);
    if (!resp.ok) {
      setStatus(`Error: ${resp.error}`);
      return;
    }
    const failedCount = (resp.failed ? resp.failed.length : 0) + fetchErrors.length;
    setStatus(
      `Done — ${resp.count} file(s) zipped into ${zipName}` +
        (failedCount ? ` (${failedCount} failed)` : '') +
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
      <label id="cld-select-all-row"><input type="checkbox" id="cld-select-all"> Select all patients</label>
      <div id="cld-patients"></div>
      <button id="cld-all" type="button">Download reports (checked patients)</button>
      <div id="cld-case-row">
        <input id="cld-case-input" type="text" placeholder="Case number e.g. 50211-18-06">
        <button id="cld-case" type="button">Download case</button>
      </div>
      <div id="cld-status">Tick patients, then download.</div>
    `;
    document.body.appendChild(panel);
    statusEl = panel.querySelector('#cld-status');

    // Populate patient checklist from the page's own dropdown
    const listEl = panel.querySelector('#cld-patients');
    const patients = getPagePatients();
    if (patients.length === 0) {
      listEl.textContent = 'No patients found — make sure you are logged in.';
      panel.querySelector('#cld-select-all-row').style.display = 'none';
    } else {
      const selectedNow = document.querySelector('#patient_id')?.value;
      for (const p of patients) {
        const row = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = p.id;
        cb.dataset.label = p.label;
        cb.checked = p.id === selectedNow;
        row.appendChild(cb);
        row.appendChild(document.createTextNode(' ' + p.label));
        listEl.appendChild(row);
      }
    }

    const selectAll = panel.querySelector('#cld-select-all');
    selectAll.addEventListener('change', () => {
      listEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        cb.checked = selectAll.checked;
      });
    });

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
