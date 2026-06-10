// One-off: build a generic /run form definition for the Lockbox Implementation
// Questionnaire by reusing the existing, hand-tuned SYSTEM_PROMPT + EXTRACTION_SCHEMA
// from src/prompts.js. Legacy card tags are remapped to [FORM_CARD:<id>] and matching
// card specs are authored below so the generic renderer in run.html can draw them.
//
// Run:  node scripts/build-lockbox-form.js

const path = require('path');
const { SYSTEM_PROMPT, EXTRACTION_SCHEMA } = require(path.join('..', 'src', 'prompts'));
const { saveForm, setActiveId } = require(path.join('..', 'src', 'formDef'));

// ── 1. Remap legacy card tags → [FORM_CARD:<id>] ────────────────────────────
const TAG_MAP = {
  '[CONTACT_CARD:bank_project]': '[FORM_CARD:contact_bank_project]',
  '[CONTACT_CARD:client_primary]': '[FORM_CARD:contact_client_primary]',
  '[CONTACT_CARD:client_secondary]': '[FORM_CARD:contact_client_secondary]',
  '[CONTACT_CARD:approval]': '[FORM_CARD:approval]',
  '[DEPOSIT_BANKING_CARD]': '[FORM_CARD:deposit_banking]',
  '[EXCEPTION_HANDLING_CARD]': '[FORM_CARD:exception_handling]',
  '[DISCREPANCY_CARD]': '[FORM_CARD:discrepancy]',
  '[PAYEE_VERIFICATION_CARD]': '[FORM_CARD:payee_verification]',
  '[BACKUP_DESTRUCTION_CARD]': '[FORM_CARD:backup_destruction]',
  '[MAIL_OUT_METHOD_CARD]': '[FORM_CARD:mail_out_method]',
  '[MAILING_ADDRESS_CARD]': '[FORM_CARD:mailing_address]',
  '[WEB_PORTAL_ARCHIVE_CARD]': '[FORM_CARD:web_portal_archive]',
  '[IMAGE_EXPOSURE_CARD]': '[FORM_CARD:image_exposure]',
  '[WEB_PORTAL_ADMIN_CARD]': '[FORM_CARD:web_portal_admin]',
  '[EMAILED_REPORTS_CARD]': '[FORM_CARD:emailed_reports]',
  '[SCHEDULED_REPORTS_CARD]': '[FORM_CARD:scheduled_reports]',
  '[DATA_CAPTURE_CARD]': '[FORM_CARD:data_capture]',
  '[SCANLINE_DEFINITION_CARD]': '[FORM_CARD:scanline_definition]',
  // [DATE_PICKER:go_live_date] is supported by run.html as-is — leave it.
};
let systemPrompt = SYSTEM_PROMPT;
for (const [from, to] of Object.entries(TAG_MAP)) {
  systemPrompt = systemPrompt.split(from).join(to);
}
// Tell the assistant that card tags must use the [FORM_CARD:...] form (it already does).
systemPrompt = systemPrompt.replace(
  'Begin each new session with a brief welcome',
  'Card tags use the form [FORM_CARD:<id>] — output the exact tag on its own line when a card is requested. ' +
    'Begin each new session with a brief welcome'
);

// ── 2. Card specs (one per remapped tag) ────────────────────────────────────
const contactFields = (withTitle) => [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'location', label: 'Location', type: 'text' },
  { key: 'phone', label: 'Phone', type: 'phone' },
  { key: 'email', label: 'Email', type: 'email' },
  ...(withTitle ? [{ key: 'jobTitle', label: 'Job Title', type: 'text' }] : []),
];

const acceptReturn = [
  { value: 'accept', label: 'Accept & Deposit' },
  { value: 'return', label: 'Return Unprocessed' },
];
const exc = (key, label) => ({ key, label, type: 'select', options: acceptReturn, required: true });

const cards = [
  // Section 1 — Contacts & Approval
  { id: 'contact_bank_project', title: 'Bank Project Contact (Implementation Consultant)',
    intro: 'Please provide the Bank Project Contact details.', fields: contactFields(true) },
  { id: 'contact_client_primary', title: 'Client Primary Contact',
    intro: 'Please provide the primary client contact for box implementation.', fields: contactFields(false) },
  { id: 'contact_client_secondary', title: 'Client Secondary Contact',
    intro: 'Please provide the secondary client contact for box implementation.', fields: contactFields(false) },
  { id: 'approval', title: 'Bank Questionnaire Approval',
    intro: 'Bank representative approving this questionnaire submission.',
    fields: [
      { key: 'name', label: 'Name (Printed)', type: 'text', required: true },
      { key: 'title', label: 'Title', type: 'text' },
      { key: 'signature', label: 'Signature', type: 'text', required: true,
        help: 'Typed name serves as electronic signature / approval to initiate box setup.' },
    ] },

  // Section 3 — Deposit & processing
  { id: 'deposit_banking', title: 'Deposit & Billing Banking Details',
    intro: 'Please provide the banking details for deposit and billing.',
    fields: [
      { key: 'depositBank', label: 'Deposit Bank', type: 'text' },
      { key: 'depositDDA', label: 'Deposit DDA #', type: 'text', validate: 'dda' },
      { key: 'depositRT', label: 'Deposit RT #', type: 'text', validate: 'rt' },
      { key: 'billingDDA', label: 'Billing DDA #', type: 'text', validate: 'dda' },
      { key: 'billingRT', label: 'Billing RT #', type: 'text', validate: 'rt' },
    ] },
  { id: 'exception_handling', title: 'Exception Handling Rules',
    intro: 'Select how to handle each exception type (recommended defaults shown in the form).',
    fields: [
      exc('blankPayee', 'Blank Payee'),
      exc('blankLegalLine', 'Blank Legal Line'),
      exc('thirdPartyChecks', 'Third Party Checks'),
      exc('missingSignature', 'Missing Signature'),
      exc('postDatedChecks', 'Post Dated Checks'),
      exc('staleDatedChecks', 'Stale Dated Checks'),
      exc('paidInFull', '“Paid in Full” Items (Best Effort)'),
      exc('foreignChecks', 'Foreign Checks'),
    ] },
  { id: 'discrepancy', title: 'Legal Line vs Courtesy Box Discrepancy',
    intro: 'What should happen when the Legal Line (written) amount differs from the courtesy box (numeric) amount?',
    fields: [
      { key: 'discrepancyHandling', label: 'Handling', type: 'select', required: true,
        options: [{ value: 'legal', label: 'Use legal (written) amount' }, { value: 'return', label: 'Return unprocessed' }] },
    ] },
  { id: 'payee_verification', title: 'Payee Verification',
    intro: 'Select how payee verification should be handled.',
    fields: [
      { key: 'payeeVerification', label: 'Verification', type: 'select', required: true,
        options: [{ value: 'all', label: 'Accept all payees' }, { value: 'listed', label: 'Accept only payees listed' }] },
      { key: 'acceptedPayees', label: 'Acceptable Payees', type: 'group', repeat: true,
        showIf: { field: 'payeeVerification', equals: 'listed' },
        fields: [{ key: 'payee', label: 'Payee name', type: 'text' }] },
    ] },
  { id: 'backup_destruction', title: 'Backup Destruction',
    intro: 'How should backup materials (other than checks) be handled?',
    fields: [
      { key: 'backupDestruction', label: 'Handling', type: 'select', required: true,
        options: [{ value: 'destroy', label: 'Temp Hold & Destroy' }, { value: 'return', label: 'Return all backup in daily package' }] },
    ] },
  { id: 'mail_out_method', title: 'Mail Out Method',
    intro: 'Select the mail out method.',
    fields: [
      { key: 'mailOutMethod', label: 'Method', type: 'select', required: true,
        options: [{ value: 'first_class', label: 'First Class' }, { value: 'express', label: 'Express Mail' }] },
      { key: 'expressDelivery', label: 'Express delivery schedule', type: 'select',
        showIf: { field: 'mailOutMethod', equals: 'express' },
        options: [{ value: 'overnight', label: 'Overnight' }, { value: 'two_day', label: 'Two Day Delivery' }] },
      { key: 'fedexAccount', label: 'FedEx # (for Express)', type: 'text', showIf: { field: 'mailOutMethod', equals: 'express' } },
      { key: 'upsAccount', label: 'UPS # (for Express)', type: 'text', showIf: { field: 'mailOutMethod', equals: 'express' } },
    ] },
  { id: 'mailing_address', title: 'Mailing Address',
    intro: 'Please provide the mailing address details.',
    fields: [
      { key: 'companyName', label: 'Company Name', type: 'text' },
      { key: 'attentionTo', label: 'Attention To', type: 'text' },
      { key: 'address1', label: 'Address Line 1', type: 'text' },
      { key: 'address2', label: 'Address Line 2', type: 'text' },
      { key: 'phone', label: 'Phone Number', type: 'phone' },
    ] },
  { id: 'web_portal_archive', title: 'Web Portal Image Archive',
    intro: 'Select the imaging requirements for this lockbox.',
    fields: [
      { key: 'archiveItems', label: 'Items to archive', type: 'multiselect',
        options: [
          { value: 'checks', label: 'Checks (required)' },
          { value: 'documents', label: 'Documents (Invoices, EOBs, etc.)' },
          { value: 'correspondence', label: 'Correspondence' },
          { value: 'envelopes', label: 'Envelopes' },
        ] },
      { key: 'fullPageScanning', label: 'Full page scanning for check & list payments? (Retail only)', type: 'select',
        options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] },
    ] },
  { id: 'image_exposure', title: 'Image Exposure',
    intro: 'Select the image exposure setting for the web portal.',
    fields: [
      { key: 'imageExposure', label: 'Image View', type: 'select', required: true,
        options: [{ value: 'dual', label: 'Dual Sided (Default)' }, { value: 'single', label: 'Single Sided' }] },
    ] },
  { id: 'web_portal_admin', title: 'Web Portal Administrators',
    intro: 'Provide the web portal administrator(s).',
    fields: [
      { key: 'admins', label: 'Administrator', type: 'group', repeat: true,
        fields: [
          { key: 'name', label: 'Name', type: 'text', required: true },
          { key: 'email', label: 'Email Address', type: 'email', required: true },
        ] },
    ] },

  // Section 4 — Reporting
  { id: 'emailed_reports', title: 'Emailed Reports',
    intro: 'Select which emailed reports to enable and the recipient address.',
    fields: [
      { key: 'emailedReports', label: 'Reports', type: 'multiselect',
        options: [
          { value: 'noActivityReport', label: 'No Activity Report' },
          { value: 'batchSummaryByMode', label: 'Batch Summary by Batch Mode' },
          { value: 'batchSummaryByNumber', label: 'Batch Summary by Batch Number' },
          { value: 'batchSummaryWithSortTypes', label: 'Batch Summary with Sort Types' },
        ] },
      { key: 'emailAddress', label: 'Email Address(es)', type: 'email' },
    ] },
  { id: 'scheduled_reports', title: 'Scheduled Reports',
    intro: 'Select which scheduled reports to enable.',
    fields: [
      { key: 'scheduledReports', label: 'Reports', type: 'multiselect',
        options: [
          { value: 'batchSummaryByMode', label: 'Batch Summary by Batch Mode' },
          { value: 'batchSummaryByNumber', label: 'Batch Summary by Batch Number' },
          { value: 'batchSummaryByModeWithSortTypes', label: 'Batch Summary by Batch Mode with Sort Types' },
          { value: 'batchImageDetail', label: 'Batch Image Detail' },
          { value: 'checkImageDetail', label: 'Check Image Detail' },
          { value: 'depositSummaryDaily', label: 'Deposit Summary (Daily)' },
          { value: 'depositSummaryMonthly', label: 'Deposit Summary (Monthly)' },
          { value: 'depositSummaryMultiple', label: 'Deposit Summary (Multiple Lockboxes)' },
        ] },
      { key: 'consolidatedReportLockboxes', label: 'Other lockboxes for consolidated deposit report', type: 'text',
        help: 'Only needed if Deposit Summary (Multiple Lockboxes) is selected.' },
    ] },

  // Section 5 — Data Entry
  { id: 'data_capture', title: 'Data Capture Fields',
    intro: 'Add one row per field to capture. Standard fields include: Remitter/Payer Name, Customer Number, Invoice Number, Invoice Amount, Gross Invoice Amt, Discount Amt, Net Invoice Amt. Use blank rows for custom fields.',
    fields: [
      { key: 'fields', label: 'Field', type: 'group', repeat: true,
        fields: [
          { key: 'fieldName', label: 'Field Name', type: 'text', required: true },
          { key: 'length', label: 'Length (digits)', type: 'number' },
          { key: 'fieldType', label: 'Type', type: 'select',
            options: [{ value: 'N', label: 'Numeric (N)' }, { value: 'AN', label: 'Alpha-Numeric (AN)' }] },
          { key: 'validation', label: 'Field Validation', type: 'text' },
        ] },
    ] },

  // Section 6 — Remittance Coupon / OCR
  { id: 'scanline_definition', title: 'Scanline Definition',
    intro: 'Define each field in the scanline, including check digits and spaces.',
    fields: [
      { key: 'rows', label: 'Scanline field', type: 'group', repeat: true,
        fields: [
          { key: 'digitStart', label: 'Digit Start', type: 'number', required: true },
          { key: 'digitEnd', label: 'Digit End', type: 'number', required: true },
          { key: 'fieldLength', label: 'Field Length', type: 'number' },
          { key: 'fieldType', label: 'Field Type', type: 'select',
            options: [{ value: 'numeric', label: 'Numeric' }, { value: 'alpha-numeric', label: 'Alpha-Numeric' }] },
          { key: 'fieldName', label: 'Field Name', type: 'text', required: true },
        ] },
    ] },
];

// ── 3. Assemble + save ──────────────────────────────────────────────────────
const def = {
  meta: { id: 'lockbox-master', title: 'Private Label Lockbox Implementation Questionnaire', version: '2.0' },
  systemPrompt,
  extractionSchema: JSON.parse(EXTRACTION_SCHEMA),
  cards,
};

// Validate: every [FORM_CARD:id] referenced in the prompt has a matching card.
const referenced = [...new Set([...systemPrompt.matchAll(/\[FORM_CARD:([a-z0-9_]+)\]/gi)].map((m) => m[1]))];
const have = new Set(cards.map((c) => c.id));
const missing = referenced.filter((id) => !have.has(id));
const extra = cards.map((c) => c.id).filter((id) => !referenced.includes(id));

const saved = saveForm(def);
setActiveId(saved.meta.id);

console.log('Saved + activated:', saved.meta.id);
console.log('Cards:', cards.length, '| Referenced tags:', referenced.length);
console.log('Missing card specs (prompt refers, no card):', missing.length ? missing.join(', ') : 'none ✓');
console.log('Unreferenced cards (card exists, prompt never shows):', extra.length ? extra.join(', ') : 'none ✓');
