// Google Drive OAuth (per-user login) + JSON upload.
// The user signs in with their own Google account; files land in their Drive.
//
// Credentials are loaded from an OAuth 2.0 "Web application" client JSON placed in
// the project root (the file you download from Google Cloud Console → Credentials).
// Resolution order:
//   1. GOOGLE_CREDENTIALS_FILE env (path, absolute or relative to project root)
//   2. the first file matching client_secret*.json in the project root
//   3. ./client_secret.json
// Optional env overrides:
//   GOOGLE_REDIRECT_URI    (else uses the first redirect_uris entry from the JSON)
//   GOOGLE_DRIVE_FOLDER_ID (target folder; omit for Drive root)
//
// Scope is drive.file (least privilege): the app can only see/manage files it creates.

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { Readable } = require('stream');

// drive.file → manage files the app creates (JSON, BRD doc, the spreadsheet);
// spreadsheets → write values/tabs into the spreadsheet via the Sheets API.
const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
];
const ROOT = path.join(__dirname, '..');

// Locate the OAuth client JSON in the project folder.
function credentialsPath() {
  if (process.env.GOOGLE_CREDENTIALS_FILE) {
    const p = path.isAbsolute(process.env.GOOGLE_CREDENTIALS_FILE)
      ? process.env.GOOGLE_CREDENTIALS_FILE
      : path.join(ROOT, process.env.GOOGLE_CREDENTIALS_FILE);
    return fs.existsSync(p) ? p : null;
  }
  let files = [];
  try { files = fs.readdirSync(ROOT); } catch { /* ignore */ }
  // Prefer an explicit client_secret*.json, then the existing gdoc_token.json.
  const match =
    files.find((f) => /^client_secret.*\.json$/i.test(f)) ||
    (files.includes('gdoc_token.json') ? 'gdoc_token.json' : null);
  if (match) return path.join(ROOT, match);
  const fallback = path.join(ROOT, 'client_secret.json');
  return fs.existsSync(fallback) ? fallback : null;
}

// Parse the JSON and pull out { clientId, clientSecret, redirectUri }.
function loadConfig() {
  const p = credentialsPath();
  if (!p) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
  const o = raw.web || raw.installed || {};
  if (!o.client_id || !o.client_secret) return null;
  // "installed"/Desktop clients only list loopback placeholders (e.g. http://localhost),
  // so for those we use our actual callback route via the loopback flow. "web" clients
  // use their registered redirect URI.
  const isInstalled = Boolean(raw.installed) && !raw.web;
  const port = process.env.PORT || 5000;
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ||
    (!isInstalled && Array.isArray(o.redirect_uris) && o.redirect_uris[0]) ||
    `http://localhost:${port}/auth/google/callback`;
  return { clientId: o.client_id, clientSecret: o.client_secret, redirectUri };
}

function isConfigured() {
  return Boolean(loadConfig());
}

function oauthClient() {
  const cfg = loadConfig();
  if (!cfg) {
    throw new Error(
      'Google Drive is not configured. Place your OAuth client JSON (client_secret*.json) ' +
        'in the project folder, or set GOOGLE_CREDENTIALS_FILE in .env.'
    );
  }
  return new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
}

// URL to send the user to for consent. `state` round-trips through the callback.
function getAuthUrl(state) {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: state || '',
  });
}

// Exchange the ?code from the callback for tokens (store these in the session).
async function exchangeCode(code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

// Upload a JSON string to the user's Drive. Returns { id, name, webViewLink }.
async function uploadJson(tokens, filename, jsonString) {
  const client = oauthClient();
  client.setCredentials(tokens);
  const drive = google.drive({ version: 'v3', auth: client });

  const folder = process.env.GOOGLE_DRIVE_FOLDER_ID && process.env.GOOGLE_DRIVE_FOLDER_ID.trim();
  const create = drive.files.create(
    {
      requestBody: {
        name: filename,
        mimeType: 'application/json',
        ...(folder ? { parents: [folder] } : {}),
      },
      media: {
        mimeType: 'application/json',
        body: Readable.from([jsonString]),
      },
      fields: 'id, name, webViewLink',
    },
    { timeout: 30000 } // fail fast instead of hanging if the network/proxy blocks googleapis
  );

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Drive upload timed out after 30s (network/proxy may be blocking googleapis.com).')), 32000)
  );
  const res = await Promise.race([create, timeout]);
  return res.data;
}

function authedClient(tokens) {
  const client = oauthClient();
  client.setCredentials(tokens);
  return client;
}

function folderId() {
  const f = process.env.GOOGLE_DRIVE_FOLDER_ID && process.env.GOOGLE_DRIVE_FOLDER_ID.trim();
  return f || null;
}

// Move an app-created file into the configured Drive folder (best-effort).
async function moveToFolder(auth, fileId) {
  const folder = folderId();
  if (!folder) return;
  try {
    const drive = google.drive({ version: 'v3', auth });
    const meta = await drive.files.get({ fileId, fields: 'parents' });
    const prev = (meta.data.parents || []).join(',');
    await drive.files.update({ fileId, addParents: folder, removeParents: prev, fields: 'id' });
  } catch (e) {
    console.error('[drive] could not move file to folder:', e.message);
  }
}

// Create a spreadsheet with one tab per section; each tab = Field | Value | Status.
// sections: [{ name, rows: [[field, value, status], ...] }]. Returns { id, url, name }.
async function createSheet(tokens, title, sections) {
  const auth = authedClient(tokens);
  const sheetsApi = google.sheets({ version: 'v4', auth });

  const tabs = sections.length ? sections : [{ name: 'Data', rows: [] }];
  const created = await sheetsApi.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: tabs.map((s) => ({ properties: { title: s.name } })),
    },
    fields: 'spreadsheetId,spreadsheetUrl',
  });
  const spreadsheetId = created.data.spreadsheetId;

  // Fill each tab.
  const valueData = tabs.map((s) => ({
    range: `'${s.name.replace(/'/g, "''")}'!A1`,
    values: [['Field', 'Value', 'Status'], ...s.rows.map((r) => [r[0] || '', r[1] || '', r[2] || ''])],
  }));
  await sheetsApi.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data: valueData },
  });

  await moveToFolder(auth, spreadsheetId);
  return { id: spreadsheetId, url: created.data.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}`, name: title };
}

// Create a Google Doc from HTML (Drive converts text/html → google-apps.document).
// Returns { id, name, webViewLink }.
async function createDoc(tokens, title, html) {
  const auth = authedClient(tokens);
  const drive = google.drive({ version: 'v3', auth });
  const folder = folderId();
  const res = await drive.files.create({
    requestBody: {
      name: title,
      mimeType: 'application/vnd.google-apps.document',
      ...(folder ? { parents: [folder] } : {}),
    },
    media: { mimeType: 'text/html', body: Readable.from([html]) },
    fields: 'id, name, webViewLink',
  });
  return res.data;
}

module.exports = { isConfigured, getAuthUrl, exchangeCode, uploadJson, createSheet, createDoc, SCOPES };
