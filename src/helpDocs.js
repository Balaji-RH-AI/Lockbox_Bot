// Help-bot knowledge base: ingest docs → chunk → embed → persist; retrieve top-k.
//
// Docs live under HELP_DOCS_DIR (default ./docs):
//   docs/*.{md,txt,docx,pdf}            → shared (available to every form)
//   docs/<formId>/*.{md,txt,docx,pdf}   → scoped to that form's help bot
// Index is persisted to ./data/help-index.json (rebuild with scripts/build-help-index.js).
//
// Embeddings use AZURE_EMBED_DEPLOYMENT (e.g. text-embedding-3-small).

const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const { getClient } = require('./openaiClient');
const usageTracker = require('./usage');

const ROOT = path.join(__dirname, '..');
const DOCS_DIR = process.env.HELP_DOCS_DIR
  ? (path.isAbsolute(process.env.HELP_DOCS_DIR) ? process.env.HELP_DOCS_DIR : path.join(ROOT, process.env.HELP_DOCS_DIR))
  : path.join(ROOT, 'docs');
const INDEX_FILE = path.join(ROOT, 'data', 'help-index.json');
const EMBED_DEPLOYMENT = process.env.AZURE_EMBED_DEPLOYMENT || 'text-embedding-3-small';

let _index = null; // { model, builtAt, chunks: [{ id, text, source, formId, embedding }] }

// ── Text extraction ─────────────────────────────────────────────────────────
async function extractFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.docx' || ext === '.doc') return (await mammoth.extractRawText({ path: file })).value;
  if (ext === '.pdf') return (await pdfParse(fs.readFileSync(file))).text;
  if (ext === '.md' || ext === '.txt' || ext === '.markdown') return fs.readFileSync(file, 'utf8');
  return '';
}

// ── Chunking (paragraph-packed, ~1500 chars with overlap) ────────────────────
function chunkText(text, source, formId) {
  const clean = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const paras = clean.split(/\n\n+/);
  const chunks = [];
  let buf = '';
  const flush = () => { if (buf.trim()) chunks.push({ text: buf.trim(), source, formId }); buf = ''; };
  for (const p of paras) {
    if ((buf + '\n\n' + p).length > 1500 && buf) {
      flush();
      buf = buf.slice(-200); // small overlap for continuity
    }
    buf += (buf ? '\n\n' : '') + p;
  }
  flush();
  return chunks;
}

// ── List docs with their formId scope ────────────────────────────────────────
function listDocFiles() {
  const out = [];
  const exts = new Set(['.md', '.txt', '.markdown', '.docx', '.doc', '.pdf']);
  if (!fs.existsSync(DOCS_DIR)) return out;
  for (const entry of fs.readdirSync(DOCS_DIR, { withFileTypes: true })) {
    const full = path.join(DOCS_DIR, entry.name);
    if (entry.isDirectory()) {
      // docs/<formId>/*
      for (const f of fs.readdirSync(full)) {
        if (exts.has(path.extname(f).toLowerCase())) out.push({ file: path.join(full, f), formId: entry.name });
      }
    } else if (exts.has(path.extname(entry.name).toLowerCase())) {
      out.push({ file: full, formId: null });
    }
  }
  return out;
}

// ── Embeddings ───────────────────────────────────────────────────────────────
async function embed(texts) {
  const client = getClient(EMBED_DEPLOYMENT);
  const vectors = [];
  const BATCH = 64;
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const resp = await client.embeddings.create({ model: EMBED_DEPLOYMENT, input: slice });
    usageTracker.record('embed', resp.usage, null);
    resp.data.forEach((d) => vectors.push(d.embedding));
  }
  return vectors;
}

// ── Build / persist the index ────────────────────────────────────────────────
async function buildIndex() {
  const files = listDocFiles();
  if (!files.length) throw new Error(`No documents found in ${DOCS_DIR}. Add .md/.txt/.docx/.pdf files first.`);

  const chunks = [];
  for (const { file, formId } of files) {
    const text = await extractFile(file);
    const rel = path.relative(DOCS_DIR, file);
    chunkText(text, rel, formId).forEach((c, i) => chunks.push({ id: `${rel}#${i}`, ...c }));
  }
  if (!chunks.length) throw new Error('Documents contained no extractable text.');

  const embeddings = await embed(chunks.map((c) => c.text));
  chunks.forEach((c, i) => { c.embedding = embeddings[i]; });

  const index = { model: EMBED_DEPLOYMENT, builtAt: new Date().toISOString(), chunks };
  fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index));
  _index = index;
  return { files: files.length, chunks: chunks.length };
}

function loadIndex() {
  if (_index) return _index;
  if (!fs.existsSync(INDEX_FILE)) return null;
  try { _index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { _index = null; }
  return _index;
}

function isReady() {
  const idx = loadIndex();
  return Boolean(idx && idx.chunks && idx.chunks.length);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// Retrieve the top-k most relevant chunks for a query (form-scoped + shared).
async function search(query, formId, k = 5) {
  const idx = loadIndex();
  if (!idx) return [];
  const [qvec] = await embed([query]);
  const candidates = idx.chunks.filter((c) => c.formId == null || c.formId === formId);
  return candidates
    .map((c) => ({ ...c, score: cosine(qvec, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

function status() {
  const idx = loadIndex();
  return {
    ready: isReady(),
    docsDir: path.relative(ROOT, DOCS_DIR),
    chunks: idx ? idx.chunks.length : 0,
    builtAt: idx ? idx.builtAt : null,
    embedModel: EMBED_DEPLOYMENT,
  };
}

module.exports = { buildIndex, search, isReady, status, DOCS_DIR, INDEX_FILE };
