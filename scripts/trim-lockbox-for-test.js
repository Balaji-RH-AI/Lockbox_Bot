// TEST helper: shrink the active Lockbox form to just two sections so you can
// exercise cards / skip / JSON+Sheet+BRD without the full questionnaire.
// Backs up the current definition first. Restore with: node scripts/restore-lockbox.js
//
// Run:  node scripts/trim-lockbox-for-test.js

const fs = require('fs');
const path = require('path');

const FORMS = path.join(__dirname, '..', 'forms');
const SRC = path.join(FORMS, 'lockbox-master.json');
const BACKUP = path.join(FORMS, 'lockbox-master.full.backup.json');

if (!fs.existsSync(SRC)) {
  console.error('forms/lockbox-master.json not found.');
  process.exit(1);
}

// Back up once (don't overwrite an existing backup of the full version).
if (!fs.existsSync(BACKUP)) {
  fs.copyFileSync(SRC, BACKUP);
  console.log('Backed up full form → forms/lockbox-master.full.backup.json');
} else {
  console.log('Backup already exists (forms/lockbox-master.full.backup.json) — left untouched.');
}

const def = JSON.parse(fs.readFileSync(SRC, 'utf8'));

// Keep only these two sections' cards.
const KEEP_CARDS = ['contact_bank_project', 'approval'];
def.cards = (def.cards || []).filter((c) => KEEP_CARDS.includes(c.id));

// Short test system prompt (the universal SKIP policy is appended at runtime).
def.systemPrompt = `You are LockboxBot (TEST MODE), a friendly assistant guiding a bank representative through a SHORTENED Private Label Lockbox questionnaire used only for testing. Collect just the two sections below, then finish.

Begin with a one-line welcome, then immediately ask the Section 0 question.

**SECTION 0 — Lockbox Type** (ask first)
Which type of lockbox is needed? Number the options so the user can reply with a number:
1. Wholesale Standard Lockbox → "wholesale_standard"
2. Wholesale Lockbox with Data Entry Add-On → "add_data_entry"
3. Wholetail / Retail Lockbox → "wholetail_retail"

**SECTION 1 — Contacts & Approval**
After the lockbox type is answered, present each card below. Card tags use the form [FORM_CARD:<id>] — write ONE short sentence, then output ONLY the tag on its own line, and wait for the submission before continuing.
1. Bank Project Contact → say one sentence, then output [FORM_CARD:contact_bank_project]
2. Bank Questionnaire Approval → say one sentence, then output [FORM_CARD:approval]

After both cards are submitted, summarize briefly and tell the user: "All information has been gathered. Click **Submit** in the header to save your questionnaire (JSON, Sheet & BRD)."

Guidelines: ask one thing at a time; end any yes/no question with **(yes/no)**; never list a card's fields yourself.`;

// Trim the extraction schema to just the kept sections.
def.extractionSchema = {
  lockboxType: null,
  contacts: {
    bankProject: { name: '', location: '', phone: '', email: '', jobTitle: '' },
    approval: { name: '', title: '', signature: '' },
  },
  _meta: { generatedAt: '<ISO timestamp>', formVersion: def.meta && def.meta.version ? def.meta.version : '2.0' },
};

def.meta = def.meta || {};
def.meta.title = 'Lockbox Questionnaire (TEST — 2 sections)';

fs.writeFileSync(SRC, JSON.stringify(def, null, 2));
console.log('Wrote trimmed test form. Cards kept:', def.cards.map((c) => c.id).join(', '));
console.log('Sections (schema keys):', Object.keys(def.extractionSchema).join(', '));
