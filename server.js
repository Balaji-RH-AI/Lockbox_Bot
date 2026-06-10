require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');

const multer = require('multer');

const { getClient } = require('./src/openaiClient');
const { getHistory, clear, conversations } = require('./src/store');
const { extractData, NoConversationError, resolvePrompts } = require('./src/extract');
const { extractText, generateDefinition } = require('./src/generator');
const {
  listForms,
  loadForm,
  saveForm,
  getActiveId,
  setActiveId,
  getActiveForm,
  renderPromptsJs,
} = require('./src/formDef');
const { clientSource } = require('./src/cardTypes');
const gdrive = require('./src/googleDrive');
const usageTracker = require('./src/usage');
const brd = require('./src/brd');
const helpDocs = require('./src/helpDocs');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const app = express();
app.set('trust proxy', 1); // Azure App Service sits behind a proxy

app.use(express.json({ limit: '1mb' }));
app.use(
  session({
    secret: process.env.SECRET_KEY || 'dev-secret-change-in-production',
    resave: false,
    saveUninitialized: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // secure: true requires HTTPS; App Service is HTTPS, but cookies must also work in local dev.
      secure: process.env.NODE_ENV === 'production',
    },
  })
);

function getSid(req) {
  if (!req.session.sid) req.session.sid = uuidv4();
  return req.session.sid;
}

const TEMPLATES_DIR = path.join(__dirname, 'templates');
const STATIC_DIR = path.join(__dirname, 'static');

app.use('/static', express.static(STATIC_DIR, { maxAge: '1h' }));

// Main app: the full-featured page (save / resume / submit) that runs whichever
// questionnaire is active — using hard-coded cards for the bundled Lockbox prompt
// and the generic data-driven engine for any generated/active form.
app.get('/', (req, res) => {
  getSid(req);
  res.sendFile(path.join(TEMPLATES_DIR, 'index.html'));
});

app.post('/chat', async (req, res) => {
  const sid = getSid(req);
  const userMsg = ((req.body && req.body.message) || '').trim();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  if (!userMsg) {
    res.write('data: {"error": "Empty message"}\n\n');
    res.end();
    return;
  }

  const history = getHistory(sid);
  history.push({ role: 'user', content: userMsg });

  const deployment = process.env.AZURE_DEPLOYMENT || 'gpt-4o-mini';
  const { systemPrompt } = resolvePrompts(req.body && req.body.formId);
  let fullText = '';

  try {
    const stream = await getClient().chat.completions.create({
      model: deployment,
      max_tokens: 4096,
      messages: [{ role: 'system', content: systemPrompt }, ...history],
      stream: true,
      stream_options: { include_usage: true }, // final chunk carries token usage
    });

    let usage = null;
    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;               // usage arrives on the last chunk
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) {
        fullText += text;
        res.write(`data: ${JSON.stringify({ text })}\n\n`);
      }
    }
    usageTracker.record('chat', usage, sid, { formId: (req.body && req.body.formId) || null });

    history.push({ role: 'assistant', content: fullText });
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (exc) {
    res.write(`data: ${JSON.stringify({ error: String(exc?.message || exc) })}\n\n`);
    if (history.length && history[history.length - 1].role === 'user') {
      history.pop();
    }
    res.end();
  }
});

app.post('/export', async (req, res) => {
  const sid = getSid(req);
  try {
    const data = await extractData(sid, req.body && req.body.formId);
    const jsonOut = JSON.stringify(data, null, 2);
    const ts = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..*/, '')
      .replace('T', '_');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=lockbox_questionnaire_${ts}.json`
    );
    res.send(jsonOut);
  } catch (exc) {
    if (exc instanceof NoConversationError) {
      res.status(404).type('application/json').send(JSON.stringify({ error: exc.message }));
    } else if (exc instanceof SyntaxError) {
      // JSON.parse failure → mirror Python's behavior of returning "{}"
      res.type('application/json').send('{}');
    } else {
      res.status(500).type('application/json').send(JSON.stringify({ error: String(exc?.message || exc) }));
    }
  }
});

// Submit = extract answers and upload the JSON to the user's Google Drive.
app.post('/submit', async (req, res) => {
  const sid = getSid(req);

  if (!gdrive.isConfigured()) {
    return res.status(503).json({ error: 'Google Drive is not configured on the server. See .env (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI).' });
  }
  if (!req.session.googleTokens) {
    return res.status(401).json({ needAuth: true, authUrl: '/auth/google' });
  }

  console.log('[submit] start — extracting answers…');
  let data;
  try {
    data = await extractData(sid, req.body && req.body.formId);
    console.log('[submit] extraction done; uploading to Drive…');
  } catch (exc) {
    console.error('[submit] extraction failed:', exc?.message || exc);
    if (exc instanceof NoConversationError) return res.status(404).json({ error: exc.message });
    return res.status(500).json({ error: String(exc?.message || exc) });
  }

  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const tokens = req.session.googleTokens;
    const base = `${brd.baseName(data)} ${ts}`;
    const sections = brd.buildSections(data);

    // 1) Raw JSON, 2) multi-tab Sheet (one tab per section), 3) BRD Google Doc.
    const jsonFile = await gdrive.uploadJson(tokens, `${base}.json`, JSON.stringify(data, null, 2));
    const sheet = await gdrive.createSheet(tokens, `${base} — Questionnaire`, sections);
    const doc = await gdrive.createDoc(tokens, `${base} — BRD`, brd.buildBrdHtml(`${brd.baseName(data)} — Business Requirements`, data, sections));

    console.log('[submit] created — json:', jsonFile.id, '| sheet:', sheet.id, '| doc:', doc.id);
    res.json({
      ok: true,
      file: jsonFile,
      outputs: {
        json: { name: jsonFile.name, link: jsonFile.webViewLink },
        sheet: { name: sheet.name, link: sheet.url },
        brd: { name: doc.name, link: doc.webViewLink },
      },
    });
  } catch (exc) {
    const msg = String(exc?.errors?.[0]?.message || exc?.response?.data?.error?.message || exc?.message || exc);
    console.error('[submit] Drive upload failed:', msg);
    // Token likely expired/revoked → force re-auth.
    if (/invalid_grant|unauthorized|invalid credentials|401|insufficient/i.test(msg)) {
      req.session.googleTokens = null;
      return res.status(401).json({ needAuth: true, authUrl: '/auth/google' });
    }
    res.status(500).json({ error: 'Drive upload failed: ' + msg });
  }
});

// Token usage (this session + global totals across chat / extract / generate).
app.get('/api/usage', (req, res) => {
  res.json(usageTracker.snapshot(getSid(req)));
});

// ── Help assistant (RAG over docs/) ─────────────────────────────────────────
app.get('/help/status', (req, res) => {
  res.json(helpDocs.status());
});

app.post('/help', async (req, res) => {
  const sid = getSid(req);
  const question = ((req.body && req.body.message) || '').trim();
  if (!question) return res.status(400).json({ error: 'Empty question.' });
  if (!helpDocs.isReady()) {
    return res.status(503).json({ error: 'Help docs are not indexed yet. Add files to docs/ and run: node scripts/build-help-index.js' });
  }

  try {
    const formId = (req.body && req.body.formId) || 'active';
    const top = await helpDocs.search(question, formId === 'active' ? getActiveId() : formId, 5);
    const context = top.map((c, i) => `[${i + 1}] (${c.source})\n${c.text}`).join('\n\n---\n\n');
    const sources = [...new Set(top.map((c) => c.source))];

    const sys =
      'You are a helpful documentation assistant for a questionnaire/intake application. ' +
      'Answer the user\'s question using ONLY the documentation excerpts provided below. ' +
      'If the answer is not contained in the documentation, say you don\'t have that information ' +
      'and suggest they check with their bank/implementation contact. Be concise and clear; ' +
      'do not invent details.\n\n=== DOCUMENTATION ===\n' + context;

    const history = Array.isArray(req.body.history)
      ? req.body.history.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-6)
      : [];

    const deployment = process.env.AZURE_DEPLOYMENT || 'gpt-4o-mini';
    const resp = await getClient().chat.completions.create({
      model: deployment,
      max_tokens: 700,
      temperature: 0.2,
      messages: [{ role: 'system', content: sys }, ...history, { role: 'user', content: question }],
    });
    usageTracker.record('help', resp.usage, sid);

    res.json({ answer: (resp.choices[0].message.content || '').trim(), sources });
  } catch (exc) {
    res.status(500).json({ error: String(exc?.message || exc) });
  }
});

// ── Google Drive OAuth flow ─────────────────────────────────────────────────
app.get('/auth/status', (req, res) => {
  res.json({ configured: gdrive.isConfigured(), connected: Boolean(req.session.googleTokens) });
});

app.get('/auth/google', (req, res) => {
  try {
    res.redirect(gdrive.getAuthUrl());
  } catch (exc) {
    res.status(503).type('text/plain').send(String(exc?.message || exc));
  }
});

app.get('/auth/google/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/?gdrive=error');
  try {
    req.session.googleTokens = await gdrive.exchangeCode(code);
    res.redirect('/?gdrive=connected');
  } catch (exc) {
    console.error('Google OAuth callback error:', exc?.message || exc);
    res.redirect('/?gdrive=error');
  }
});

app.post('/auth/google/disconnect', (req, res) => {
  req.session.googleTokens = null;
  res.json({ ok: true });
});

app.post('/session/restore', (req, res) => {
  const sid = getSid(req);
  const history = (req.body && Array.isArray(req.body.history)) ? req.body.history : null;
  if (!history) {
    return res.status(400).type('application/json').send(JSON.stringify({ error: 'history array required' }));
  }
  const clean = history
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content }));
  conversations.set(sid, clean);
  res.type('application/json').send(JSON.stringify({ ok: true, count: clean.length }));
});

app.get('/session/history', (req, res) => {
  const sid = getSid(req);
  res.type('application/json').send(JSON.stringify({ history: getHistory(sid) }));
});

app.post('/reset', (req, res) => {
  const sid = req.session.sid;
  if (sid) clear(sid);
  req.session.sid = uuidv4();
  res.type('application/json').send(JSON.stringify({ ok: true }));
});

// ─────────────────────────────────────────────────────────────────────────
// Generator + generic-runtime routes
// ─────────────────────────────────────────────────────────────────────────

// Generator web UI: upload/paste a questionnaire → produce a form definition.
app.get('/generator', (req, res) => {
  res.sendFile(path.join(TEMPLATES_DIR, 'generator.html'));
});

// Generic runtime page that renders ANY active form definition's cards.
app.get('/run', (req, res) => {
  getSid(req);
  res.sendFile(path.join(TEMPLATES_DIR, 'run.html'));
});

// Convert an uploaded document OR pasted text into a form definition.
// Accepts multipart (field "file") and/or body { text, title, activate }.
app.post('/generate', upload.single('file'), async (req, res) => {
  try {
    const title = (req.body && req.body.title) || '';
    let text = (req.body && req.body.text) || '';
    if (req.file) {
      text = await extractText(req.file.buffer, req.file.originalname);
    }
    if (!text.trim()) {
      return res.status(400).json({ error: 'Provide a file or some questionnaire text.' });
    }
    const def = await generateDefinition(text, { title });
    const saved = saveForm(def);
    const activate = !req.body || req.body.activate === undefined || req.body.activate === 'true' || req.body.activate === true;
    if (activate) setActiveId(saved.meta.id);
    res.json({ ok: true, active: activate, def: saved });
  } catch (exc) {
    res.status(500).json({ error: String(exc?.message || exc) });
  }
});

// List stored forms + which is active.
app.get('/api/forms', (req, res) => {
  res.json({ active: getActiveId(), forms: listForms() });
});

// Switch the active form.
app.post('/api/forms/active', (req, res) => {
  const id = req.body && req.body.id;
  if (!id || !loadForm(id)) return res.status(404).json({ error: 'Unknown form id.' });
  setActiveId(id);
  res.json({ ok: true, active: id });
});

// The active form's runtime config consumed by run.html:
// cards + meta + the validator table as browser JS source.
app.get('/api/form', (req, res) => {
  const def = getActiveForm();
  if (!def) return res.status(404).json({ error: 'No active form. Generate one at /generator.' });
  res.json({
    meta: def.meta,
    cards: def.cards || [],
    validatorSource: clientSource(),
  });
});

// Download a stored (or active) definition rendered as a prompts.js module.
app.get('/api/form/prompts.js', (req, res) => {
  const id = req.query.id;
  const def = id ? loadForm(id) : getActiveForm();
  if (!def) return res.status(404).type('text/plain').send('// No form found.');
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Content-Disposition', `attachment; filename=prompts.${def.meta?.id || 'form'}.js`);
  res.send(renderPromptsJs(def));
});

// Download the raw definition JSON.
app.get('/api/form/definition.json', (req, res) => {
  const id = req.query.id;
  const def = id ? loadForm(id) : getActiveForm();
  if (!def) return res.status(404).json({ error: 'No form found.' });
  res.setHeader('Content-Disposition', `attachment; filename=${def.meta?.id || 'form'}.json`);
  res.json(def);
});

const PORT = parseInt(process.env.PORT, 10) || 5000;
app.listen(PORT, () => {
  console.log(`Lockbox bot listening on port ${PORT}`);
});
