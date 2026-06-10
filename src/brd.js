// Transform an extracted questionnaire JSON into:
//   • sections  → [{ name, rows: [[field, value, status], ...] }]  (one per top-level group)
//   • BRD HTML  → a formatted document (Drive converts it to a Google Doc)
// Form-agnostic: each top-level object key becomes a section/tab; root scalars go to "Overview".

function humanize(k) {
  return String(k)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function fmtVal(v) {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  if (v === null || v === undefined) return '';
  return String(v);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Flatten a nested object/array into [label, value, status] rows.
function flatten(obj, prefix, rows) {
  for (const [k, v] of Object.entries(obj)) {
    const label = prefix ? `${prefix} › ${humanize(k)}` : humanize(k);
    if (Array.isArray(v)) {
      if (!v.length) { rows.push([label, '', '']); continue; }
      v.forEach((item, i) => {
        if (item && typeof item === 'object') flatten(item, `${label} #${i + 1}`, rows);
        else rows.push([`${label} #${i + 1}`, item === 'PENDING' ? '' : fmtVal(item), item === 'PENDING' ? 'PENDING' : '']);
      });
    } else if (v && typeof v === 'object') {
      flatten(v, label, rows);
    } else {
      rows.push([label, v === 'PENDING' ? '' : fmtVal(v), v === 'PENDING' ? 'PENDING' : '']);
    }
  }
}

// Build sections. Tab names are unique and ≤31 chars (Sheets limit).
function buildSections(data) {
  const sections = [];
  const overview = [];
  for (const [k, v] of Object.entries(data)) {
    if (k === '_meta' || k === '_pendingFields') continue;
    if (Array.isArray(v)) {
      const rows = []; flatten({ [k]: v }, '', rows);
      sections.push({ name: humanize(k), rows });
    } else if (v && typeof v === 'object') {
      const rows = []; flatten(v, '', rows);
      sections.push({ name: humanize(k), rows });
    } else {
      overview.push([humanize(k), v === 'PENDING' ? '' : fmtVal(v), v === 'PENDING' ? 'PENDING' : '']);
    }
  }
  if (overview.length) sections.unshift({ name: 'Overview', rows: overview });

  // Enforce unique, length-limited tab names.
  const seen = new Set();
  sections.forEach((s) => {
    let name = (s.name || 'Section').slice(0, 31).replace(/[\[\]\*\/\\\?:]/g, ' ').trim() || 'Section';
    let base = name, n = 1;
    while (seen.has(name.toLowerCase())) { name = `${base.slice(0, 28)} ${++n}`; }
    seen.add(name.toLowerCase());
    s.name = name;
  });
  return sections;
}

// Build a formatted BRD as HTML (Drive converts HTML → Google Doc).
function buildBrdHtml(title, data, sections) {
  const meta = data._meta || {};
  const pend = Array.isArray(data._pendingFields) ? data._pendingFields : [];
  let h = '';
  h += `<h1>${esc(title)}</h1>`;
  h += `<p style="color:#555">Business Requirements Document &nbsp;|&nbsp; Generated: ${esc(meta.generatedAt || '')}`;
  if (meta.formVersion) h += ` &nbsp;|&nbsp; Form v${esc(meta.formVersion)}`;
  h += `</p>`;

  if (pend.length) {
    h += `<h2 style="color:#b91c1c">⚠ Pending / Follow-up Required (${pend.length})</h2>`;
    h += `<p>The following items were deferred by the customer and must be followed up on:</p><ul>`;
    pend.forEach((p) => { h += `<li>${esc(p.question || p.path)} <span style="color:#888">(${esc(p.path)})</span></li>`; });
    h += `</ul>`;
  } else {
    h += `<p style="color:#16a34a"><b>All questions answered — no pending items.</b></p>`;
  }

  sections.forEach((s) => {
    h += `<h2>${esc(s.name)}</h2>`;
    if (!s.rows.length) { h += `<p style="color:#888">No data captured.</p>`; return; }
    h += `<table style="border-collapse:collapse;width:100%">`;
    s.rows.forEach((r) => {
      const pending = r[2] === 'PENDING';
      const val = pending ? `<i style="color:#b91c1c">PENDING — follow up</i>` : esc(r[1]);
      h += `<tr>` +
        `<td style="border:1px solid #ccc;padding:6px;width:40%;background:#f7f7f7"><b>${esc(r[0])}</b></td>` +
        `<td style="border:1px solid #ccc;padding:6px">${val}</td></tr>`;
    });
    h += `</table>`;
  });
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif">${h}</body></html>`;
}

// A sensible base name for the generated files (company name if present).
function baseName(data) {
  const gi = data.generalInfo || {};
  const company = gi.companyName || gi.company || (data.contacts && data.contacts.bankProject && data.contacts.bankProject.name) || '';
  const safe = String(company).replace(/[^\w\- ]+/g, '').trim().slice(0, 40);
  return safe || 'Questionnaire';
}

module.exports = { buildSections, buildBrdHtml, baseName, humanize };
