// Turns a raw questionnaire (Word/PDF/plain text) into a form definition:
//   { meta, systemPrompt, extractionSchema, cards }
// via the Azure OpenAI client already configured for the bot.

const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const { getClient } = require('./openaiClient');
const { FIELD_TYPES, VALIDATORS, TYPE_VALIDATOR } = require('./cardTypes');
const usageTracker = require('./usage');

// ── 1. Extract plain text from an uploaded document ─────────────────────────
async function extractText(buffer, filename = '') {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'docx' || ext === 'doc') {
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  }
  if (ext === 'pdf') {
    const { text } = await pdfParse(buffer);
    return text;
  }
  // txt / md / unknown → treat as utf-8 text
  return buffer.toString('utf8');
}

// ── 2. Meta-prompt that instructs the LLM to emit a form definition ─────────
function buildMetaPrompt() {
  const validatorNames = Object.keys(VALIDATORS).join(', ');
  return `You are a questionnaire-to-chatbot compiler. You are given the raw text of a
questionnaire / intake form. Convert it into a JSON "form definition" that drives a
conversational data-collection assistant.

Return ONLY a single JSON object (no markdown fences, no commentary) with this shape:

{
  "meta": { "title": "<concise form title>", "version": "1.0" },
  "systemPrompt": "<full system prompt instructing the assistant how to run the interview>",
  "extractionSchema": { ...nested JSON object mirroring every field, with null/""/false defaults... },
  "cards": [
    {
      "id": "<snake_case_id>",
      "title": "<card title>",
      "intro": "<one short sentence shown above the card>",
      "fields": [
        {
          "key": "<camelCaseKey>",
          "label": "<label>",
          "type": "<one of: ${FIELD_TYPES.join(' | ')}>",
          "required": true|false,
          "options": [ { "value": "<v>", "label": "<l>" } ],   // only for select/multiselect
          "validate": "<one of: ${validatorNames}>",            // optional; type email/phone/date/number auto-validate
          "placeholder": "<optional>",
          "help": "<optional helper text>",
          "showIf": { "field": "<otherKey>", "equals": "<value>" }, // optional conditional
          "fields": [ ...sub-fields... ],   // ONLY for type "group"
          "repeat": true|false              // ONLY for type "group" — allows multiple rows
        }
      ]
    }
  ]
}

RULES FOR DECIDING CARDS vs CONVERSATION:
- Use a CARD for any group of related fields that belong together (e.g. an address, a contact,
  banking details, a set of checkboxes, a multi-row table). A card may also hold a single rich
  field such as a date picker or a long select list.
- Simple standalone scalar questions (one short text/number/yes-no answer) should be asked
  conversationally in the systemPrompt, NOT as cards.
- Repeating tables (e.g. "list each contact", "define each scanline row") → one card with a
  "group" field that has "repeat": true.

RULES FOR THE systemPrompt YOU WRITE:
- Begin with a warm one-line welcome, then ask questions section by section, ONE AT A TIME,
  waiting for the answer before the next. Never ask more than ~3 at once.
- Whenever a question is answered by a CARD, the assistant must write ONE short sentence and then,
  on the very NEXT line, output ONLY the tag [FORM_CARD:<that card id>] — nothing else. It must NOT
  list the card's fields. Document every card id this way in the systemPrompt.
- For every yes/no question, end it with **(yes/no)** so the UI can show Yes/No buttons.
- Always number options (1, 2, 3…) when listing choices so the user can reply with numbers.
- Include a VALIDATION section telling the assistant to validate values (emails, phones, dates,
  routing/account numbers, states, ZIPs, etc.) and re-prompt on failure with a specific message.
- End by telling the user that when finished they can click "Export JSON" to download their answers.

RULES FOR extractionSchema:
- Mirror EVERY collected field. Use null for unanswered scalars, "" for text, false for checkboxes.
- Group keys to match the cards/sections. Use camelCase keys consistent with card field "key"s.
- Include a "_meta": { "generatedAt": "<ISO timestamp>", "formVersion": "1.0" } object.

EXAMPLE of the operational style the systemPrompt must use (note the tag on its own line):
"""
Welcome! Let's begin. First, what is your company's legal name?
... (after each answer, ask the next single question) ...
Now I'll collect your primary contact's details.
[FORM_CARD:primary_contact]
... (wait for submission, then continue) ...
Do you hold SOC 2 certification? **(yes/no)**
"""

Be thorough: capture every question in the source. Do not invent questions that are not present.`;
}

// ── 3. Generate the definition ──────────────────────────────────────────────
async function generateDefinition(questionnaireText, { title } = {}) {
  if (!questionnaireText || !questionnaireText.trim()) {
    throw new Error('Questionnaire text is empty.');
  }
  const deployment = process.env.AZURE_DEPLOYMENT || 'gpt-4o-mini';
  const maxTokens = parseInt(process.env.GENERATOR_MAX_TOKENS, 10) || 16384;
  const resp = await getClient().chat.completions.create({
    model: deployment,
    max_tokens: maxTokens,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildMetaPrompt() },
      {
        role: 'user',
        content:
          (title ? `Suggested title: ${title}\n\n` : '') +
          `Questionnaire text:\n"""\n${questionnaireText.slice(0, 60000)}\n"""`,
      },
    ],
  });

  usageTracker.record('generate', resp.usage, null);

  const finish = resp.choices[0].finish_reason;
  let raw = (resp.choices[0].message.content || '').trim();
  if (raw.startsWith('```')) {
    const nl = raw.indexOf('\n');
    if (nl !== -1) raw = raw.slice(nl + 1);
    const last = raw.lastIndexOf('```');
    if (last !== -1) raw = raw.slice(0, last);
    raw = raw.trim();
  }

  let def;
  try {
    def = JSON.parse(raw);
  } catch (e) {
    // The most common failure is a length-truncated response. Try to salvage
    // it (close dangling strings/brackets); if that fails, give a clear hint.
    def = salvageJson(raw);
    if (!def) {
      if (finish === 'length') {
        throw new Error(
          'The questionnaire was too large for the model to convert in one pass ' +
            `(output hit the ${maxTokens}-token limit). Split it into smaller sections ` +
            'and generate them separately, or raise GENERATOR_MAX_TOKENS.'
        );
      }
      throw new Error('Model did not return valid JSON: ' + e.message);
    }
  }
  return normalizeDefinition(def, title);
}

// Best-effort repair of a truncated JSON object: drop a trailing partial token,
// close an unterminated string, then balance braces/brackets and retry.
function salvageJson(raw) {
  let s = String(raw).trim();
  if (!s.startsWith('{')) return null;
  // Count quotes outside escapes to detect an open string.
  let inStr = false, esc = false;
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') stack.pop();
  }
  if (inStr) s += '"';                       // close dangling string
  s = s.replace(/,\s*$/, '');                // drop trailing comma
  while (stack.length) s += stack.pop() === '{' ? '}' : ']'; // balance
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Infer a validator from a field's key/label when the model didn't set one.
// Keeps validation working regardless of model diligence.
function inferValidator(field) {
  if (field.validate) return field.validate;
  if (TYPE_VALIDATOR[field.type]) return null; // type already implies one
  const k = `${field.key || ''} ${field.label || ''}`.toLowerCase();
  if (/\brout(ing)?\b|\b(rt|aba)\b/.test(k)) return 'rt';
  if (/\b(dda|account)\b/.test(k) && /num|no\b|#/.test(k)) return 'dda';
  if (/\bzip|postal\b/.test(k)) return 'zip';
  if (/\bstate\b|province/.test(k)) return 'state';
  if (/\bemail\b/.test(k)) return 'email';
  if (/\bphone|mobile|tel\b/.test(k)) return 'phone';
  return null;
}

function annotateFields(fields) {
  (fields || []).forEach((f) => {
    if (f.type === 'group') return annotateFields(f.fields);
    const v = inferValidator(f);
    if (v && !f.validate) f.validate = v;
  });
}

// Guarantee the system prompt operationally references every card via its
// [FORM_CARD:<id>] tag — the runtime cannot show a card otherwise. If the model
// omitted them, append an explicit operational section listing each one.
function ensureCardTags(def) {
  const present = new Set(
    [...def.systemPrompt.matchAll(/\[FORM_CARD:([a-z0-9_]+)\]/gi)].map((m) => m[1].toLowerCase())
  );
  const missing = def.cards.filter((c) => !present.has(String(c.id).toLowerCase()));
  if (!missing.length) return;
  const lines = missing.map(
    (c) =>
      `- For "${c.title || c.id}": say one short sentence, then on the NEXT line output ONLY [FORM_CARD:${c.id}] and wait for the submission.`
  );
  def.systemPrompt +=
    `\n\n━━━ STRUCTURED INPUT CARDS (mandatory) ━━━\n` +
    `When collecting the information below, you MUST present it using its card by outputting the exact tag on its own line — never list the card's fields yourself:\n` +
    lines.join('\n') +
    `\nAsk simple standalone questions conversationally, one at a time, and end every yes/no question with **(yes/no)**.`;
}

// Defensive normalization so a slightly-off model response still runs.
function normalizeDefinition(def, fallbackTitle) {
  def = def && typeof def === 'object' ? def : {};
  def.meta = def.meta || {};
  if (!def.meta.title) def.meta.title = fallbackTitle || 'Untitled Questionnaire';
  def.meta.version = def.meta.version || '1.0';
  def.meta.generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  def.systemPrompt = typeof def.systemPrompt === 'string' ? def.systemPrompt : '';
  if (!def.extractionSchema || typeof def.extractionSchema !== 'object') def.extractionSchema = {};
  def.extractionSchema._meta = { generatedAt: '<ISO timestamp>', formVersion: def.meta.version };
  def.cards = Array.isArray(def.cards) ? def.cards : [];
  def.cards.forEach((c, i) => {
    c.id = (c.id || `card_${i + 1}`).toString().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
    c.fields = Array.isArray(c.fields) ? c.fields : [];
    annotateFields(c.fields);
  });
  ensureCardTags(def);
  return def;
}

module.exports = { extractText, generateDefinition, buildMetaPrompt, normalizeDefinition };
