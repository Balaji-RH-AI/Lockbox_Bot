const { getClient } = require('./openaiClient');
const { getHistory } = require('./store');
const { SYSTEM_PROMPT, EXTRACTION_SCHEMA } = require('./prompts');
const { getActiveForm, loadForm } = require('./formDef');
const usageTracker = require('./usage');

class NoConversationError extends Error {}

// Universal policy appended to every form's system prompt: lets the customer
// defer any question; deferred answers are later flagged as PENDING for CRM follow-up.
const SKIP_POLICY = `

═══════════════════════════════════════════
SKIP / ANSWER-LATER POLICY (applies to every question)
═══════════════════════════════════════════
If the user does not know an answer or wants to answer later — e.g. they say "skip", "I don't know", "not sure", "later", "n/a", or they defer a form card — accept it politely WITHOUT insisting. Briefly acknowledge it will be flagged for follow-up (e.g. "No problem — I'll mark that as pending so it can be followed up later."), then move on to the next question. Never block progress on a deferred answer. Validation still applies to answers that ARE given, but the user may always choose to defer instead.`;

// Resolve the system prompt + extraction schema.
//  - formId provided  → that generated form definition (used by /run)
//  - formId omitted    → the bundled legacy Lockbox prompts.js (used by /)
// Passing formId === 'active' selects whatever form is currently active.
function resolvePrompts(formId) {
  let def = null;
  if (formId === 'active') def = getActiveForm();
  else if (formId) def = loadForm(formId);
  if (def && def.systemPrompt) {
    const schema =
      typeof def.extractionSchema === 'string'
        ? def.extractionSchema
        : JSON.stringify(def.extractionSchema, null, 2);
    return { systemPrompt: def.systemPrompt + SKIP_POLICY, extractionSchema: schema, version: def.meta?.version || '1.0' };
  }
  return { systemPrompt: SYSTEM_PROMPT + SKIP_POLICY, extractionSchema: EXTRACTION_SCHEMA, version: '2.0' };
}

// Walk the extracted object and collect dotted paths whose value is "PENDING".
function collectPendingPaths(obj, prefix = '') {
  const out = [];
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => out.push(...collectPendingPaths(v, `${prefix}[${i}]`)));
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (k === '_pendingFields' || k === '_meta') continue;
      const p = prefix ? `${prefix}.${k}` : k;
      if (v === 'PENDING') out.push(p);
      else out.push(...collectPendingPaths(v, p));
    }
  }
  return out;
}

async function extractData(sid, formId) {
  const history = getHistory(sid);
  if (!history.length) {
    throw new NoConversationError('No conversation found. Please complete the questionnaire first.');
  }

  const { systemPrompt, extractionSchema, version } = resolvePrompts(formId);

  const extractionPrompt =
    'Based on our entire conversation above, extract all the information that was provided ' +
    'and populate it into the following JSON schema. Use null for fields not discussed, ' +
    'false for unchecked checkboxes, and empty string for unfilled text fields. ' +
    "For yes/no fields use the string 'yes' or 'no'. " +
    'IMPORTANT: If the user explicitly skipped a question, said they did not know, or chose to ' +
    'answer it later, set that field\'s value to the string "PENDING" (NOT null). Reserve null ' +
    'strictly for topics that were never discussed at all. ' +
    'Also add a top-level "_pendingFields" array; for every field set to "PENDING" include an ' +
    'entry { "path": "<dot.path.to.the.field>", "question": "<the short question text>" }. ' +
    'Return ONLY the JSON object with no markdown fences or extra commentary.\n\n' +
    `Schema to fill:\n${extractionSchema}`;

  const deployment = process.env.AZURE_DEPLOYMENT || 'gpt-4o-mini';
  const response = await getClient().chat.completions.create({
    model: deployment,
    max_tokens: 4096,
    messages: [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: extractionPrompt },
    ],
  });

  usageTracker.record('extract', response.usage, sid, { formId: formId || null });

  let raw = (response.choices[0].message.content || '').trim();
  if (raw.startsWith('```')) {
    const firstNl = raw.indexOf('\n');
    if (firstNl !== -1) raw = raw.slice(firstNl + 1);
    const lastFence = raw.lastIndexOf('```');
    if (lastFence !== -1) raw = raw.slice(0, lastFence);
    raw = raw.trim();
  }

  const data = JSON.parse(raw);
  if (!data._meta || typeof data._meta !== 'object') data._meta = {};
  data._meta.generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  data._meta.formVersion = version;
  data._meta.tokenUsage = usageTracker.sessionUsage(sid); // tokens spent on this session

  // Reconcile _pendingFields with the actual "PENDING" values so CRM always gets
  // a complete, accurate follow-up list even if the model under/over-reported it.
  const modelPending = Array.isArray(data._pendingFields) ? data._pendingFields : [];
  const byPath = new Map(modelPending.filter(p => p && p.path).map(p => [p.path, p]));
  const actualPaths = collectPendingPaths(data);
  for (const p of actualPaths) {
    if (!byPath.has(p)) byPath.set(p, { path: p, question: '' });
  }
  // Drop entries the model listed that aren't actually PENDING anymore.
  data._pendingFields = [...byPath.values()].filter(e => actualPaths.includes(e.path));
  data._meta.pendingCount = data._pendingFields.length;

  return data;
}

module.exports = { extractData, NoConversationError, resolvePrompts };
