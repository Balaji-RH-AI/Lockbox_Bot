// Azure OpenAI token-usage tracker with persistence.
//
//  • Per-call audit trail  → logs/token-usage.jsonl  (one JSON line per API call)
//  • All-time aggregates   → logs/token-usage-totals.json (survives restarts)
//  • In-memory per-session totals (reset on restart; sid is per browser session)
//
// Override the directory with TOKEN_LOG_DIR. Set TOKEN_LOG_DISABLED=1 to skip file I/O.

const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.TOKEN_LOG_DIR
  ? (path.isAbsolute(process.env.TOKEN_LOG_DIR) ? process.env.TOKEN_LOG_DIR : path.join(__dirname, '..', process.env.TOKEN_LOG_DIR))
  : path.join(__dirname, '..', 'logs');
const JSONL_FILE = path.join(LOG_DIR, 'token-usage.jsonl');
const TOTALS_FILE = path.join(LOG_DIR, 'token-usage-totals.json');
const PERSIST = process.env.TOKEN_LOG_DISABLED !== '1';

function blank() {
  return { prompt: 0, completion: 0, total: 0, cached: 0, calls: 0 };
}

const byCategory = {};           // category -> blank()   (all-time, persisted)
const bySession = new Map();     // sid -> { total, categories }  (in-memory)
let startedAt = new Date().toISOString();

function ensureDir() {
  if (PERSIST && !fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Load all-time aggregates from disk so the global counter is cumulative.
(function loadTotals() {
  if (!PERSIST) return;
  try {
    if (fs.existsSync(TOTALS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(TOTALS_FILE, 'utf8'));
      Object.assign(byCategory, saved.byCategory || {});
      if (saved.since) startedAt = saved.since;
    }
  } catch { /* ignore corrupt file */ }
})();

function add(target, p, c, t, cached) {
  target.prompt += p; target.completion += c; target.total += t;
  target.cached += cached || 0; target.calls += 1;
}

function persistTotals() {
  if (!PERSIST) return;
  try {
    ensureDir();
    fs.writeFileSync(TOTALS_FILE, JSON.stringify({ since: startedAt, updatedAt: new Date().toISOString(), byCategory, grandTotal: grandTotal() }, null, 2));
  } catch (e) { console.error('[tokens] could not persist totals:', e.message); }
}

function appendJsonl(entry) {
  if (!PERSIST) return;
  try {
    ensureDir();
    fs.appendFileSync(JSONL_FILE, JSON.stringify(entry) + '\n');
  } catch (e) { console.error('[tokens] could not write audit log:', e.message); }
}

// Record one API call's usage. `usage` = { prompt_tokens, completion_tokens, total_tokens }.
// `meta` (optional) extra fields for the audit line (e.g. { formId, user }).
function record(category, usage, sid, meta) {
  if (!usage) return;
  const p = usage.prompt_tokens || 0;
  const c = usage.completion_tokens || 0;
  const t = usage.total_tokens || p + c;
  // Cached prompt tokens (served from Azure/OpenAI prompt cache, billed ~50% cheaper).
  const cached = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
  if (!t) return;

  if (!byCategory[category]) byCategory[category] = blank();
  add(byCategory[category], p, c, t, cached);

  if (sid) {
    if (!bySession.has(sid)) bySession.set(sid, { total: blank(), categories: {} });
    const s = bySession.get(sid);
    add(s.total, p, c, t, cached);
    if (!s.categories[category]) s.categories[category] = blank();
    add(s.categories[category], p, c, t, cached);
  }

  const grand = grandTotal();
  console.log(
    `[tokens] ${category}: +${t} (prompt ${p}, cached ${cached}, completion ${c})` +
      (sid ? ` | session ${String(sid).slice(0, 8)} total ${bySession.get(sid).total.total}` : '') +
      ` | grand ${grand.total}`
  );

  appendJsonl({
    ts: new Date().toISOString(),
    category,
    sid: sid || null,
    model: process.env.AZURE_DEPLOYMENT || 'gpt-4o-mini',
    prompt: p, completion: c, total: t, cached,
    grandTotal: grand.total,
    ...(meta && typeof meta === 'object' ? meta : {}),
  });
  persistTotals();
}

function grandTotal() {
  const g = blank();
  for (const cat of Object.values(byCategory)) {
    g.prompt += cat.prompt; g.completion += cat.completion; g.total += cat.total;
    g.cached += cat.cached || 0; g.calls += cat.calls;
  }
  return g;
}

// Cached prompt tokens are billed at ~50%, so effective billable ≈ total − 0.5·cached.
function billable(t) {
  return Math.max(0, (t.total || 0) - Math.round((t.cached || 0) * 0.5));
}

// Flattened per-session usage suitable for embedding in exported JSON.
function sessionUsage(sid) {
  const s = (sid && bySession.has(sid)) ? bySession.get(sid) : { total: blank(), categories: {} };
  const cat = (k) => (s.categories[k] && s.categories[k].total) || 0;
  return {
    prompt: s.total.prompt, completion: s.total.completion, total: s.total.total,
    cached: s.total.cached, billableEstimate: billable(s.total), calls: s.total.calls,
    byCategory: { chat: cat('chat'), extract: cat('extract'), generate: cat('generate') },
    model: process.env.AZURE_DEPLOYMENT || 'gpt-4o-mini',
  };
}

function snapshot(sid) {
  return {
    startedAt,
    grandTotal: grandTotal(),
    byCategory,
    session: sid && bySession.has(sid) ? bySession.get(sid) : { total: blank(), categories: {} },
    deployment: process.env.AZURE_DEPLOYMENT || 'gpt-4o-mini',
    log: PERSIST ? path.relative(path.join(__dirname, '..'), JSONL_FILE) : null,
  };
}

module.exports = { record, grandTotal, snapshot, sessionUsage };
