// Fetches all report files, bundles them into a single ZIP (store method —
// PDFs are already compressed), and triggers one download so the user is
// prompted to save only once.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'download-zip') return;
  handleZip(msg, sender.tab && sender.tab.id).then(sendResponse);
  return true; // keep sendResponse alive for the async work
});

async function handleZip({ zipName, files }, tabId) {
  const entries = [];
  const failed = [];
  let done = 0;
  for (const f of files) {
    try {
      const res = await fetch(f.url, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = new Uint8Array(await res.arrayBuffer());
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('html') || data[0] === 0x3c /* '<' */) {
        throw new Error('server sent a web page instead of a file');
      }
      entries.push({ name: uniqueName(f.name, entries), data });
    } catch (err) {
      failed.push(`${f.name}: ${err.message}`);
    }
    done++;
    notify(tabId, { type: 'zip-progress', phase: 'fetch', done, total: files.length });
  }

  if (entries.length === 0) {
    return { ok: false, error: `All downloads failed (${failed[0]})` };
  }

  notify(tabId, { type: 'zip-progress', phase: 'zip' });
  const zip = buildZip(entries);
  const url = 'data:application/zip;base64,' + toBase64(zip);

  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename: zipName, conflictAction: 'uniquify' }, () => {
      const err = chrome.runtime.lastError;
      resolve(err ? { ok: false, error: err.message } : { ok: true, count: entries.length, failed });
    });
  });
}

function notify(tabId, msg) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, msg, () => void chrome.runtime.lastError);
}

function uniqueName(name, entries) {
  const names = new Set(entries.map((e) => e.name));
  if (!names.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let i = 2;
  while (names.has(`${base} (${i})${ext}`)) i++;
  return `${base} (${i})${ext}`;
}

// ---------- minimal ZIP writer (store method, UTF-8 names) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function buildZip(entries) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // flags: UTF-8 names
    lv.setUint16(8, 0, true); // method: store
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, e.data.length, true); // compressed size
    lv.setUint32(22, e.data.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(nameBytes, 30);
    localParts.push(local, e.data);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true); // local header offset
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length + e.data.length;
  }

  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory signature
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + 22);
  let pos = 0;
  for (const part of [...localParts, ...centralParts, eocd]) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

function toBase64(u8) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(s);
}
