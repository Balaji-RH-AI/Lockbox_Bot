// Shared vocabulary for the generic, data-driven questionnaire engine.
// Both the generator (to tell the LLM what it may emit) and the runtime
// renderer/validator import from here so there is ONE source of truth.

// ── Field types a card may contain ─────────────────────────────────────────
// Each generated card is { id, title, intro, fields: [field, ...] }
// A field is:
//   {
//     key:        unique-within-card identifier (camelCase),
//     label:      human label,
//     type:       one of FIELD_TYPES below,
//     options?:   [{ value, label }]  (for select / multiselect),
//     validate?:  validator name from VALIDATORS (or null),
//     required?:  boolean,
//     placeholder?: string,
//     help?:      short helper text,
//     showIf?:    { field: <key>, equals: <value> }  conditional visibility,
//     fields?:    [field]   (only for type "group"),
//     repeat?:    boolean   (only for type "group" — allow N rows)
//   }
const FIELD_TYPES = [
  'text',        // single-line text
  'textarea',    // multi-line text
  'number',      // numeric
  'email',       // email (implies validate:"email")
  'phone',       // US phone (implies validate:"phone")
  'date',        // date picker, ISO yyyy-mm-dd
  'select',      // choose exactly one (radio)
  'multiselect', // choose any (checkboxes)
  'checkbox',    // single boolean
  'group',       // composite of sub-fields; set repeat:true for repeating rows
];

// US states + DC + territories for the "state" validator.
const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC','PR','VI','GU','AS','MP',
]);
const US_STATE_NAMES = new Set([
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut',
  'delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa',
  'kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan',
  'minnesota','mississippi','missouri','montana','nebraska','nevada',
  'new hampshire','new jersey','new mexico','new york','north carolina',
  'north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island',
  'south carolina','south dakota','tennessee','texas','utah','vermont',
  'virginia','washington','west virginia','wisconsin','wyoming',
  'district of columbia','puerto rico','virgin islands','guam','american samoa',
  'northern mariana islands',
]);

// ── Validators ──────────────────────────────────────────────────────────────
// Each: { test(value) -> bool, message, example }. Pure & dependency-free so the
// SAME source can be stringified and shipped to the browser (see clientSource()).
const VALIDATORS = {
  email: {
    test: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim()),
    message: 'Enter a valid email address (e.g. jane.doe@bank.com).',
    example: 'jane.doe@bank.com',
  },
  phone: {
    test: (v) => {
      const d = String(v).replace(/[^\d]/g, '').replace(/^1/, '');
      return d.length === 10 && !/^[01]/.test(d);
    },
    message: 'Enter a valid 10-digit US phone number.',
    example: '(555) 123-4567',
  },
  dda: {
    test: (v) => /^\d{1,20}$/.test(String(v).trim()),
    message: 'Account number must be 1–20 digits, no spaces or dashes.',
    example: '1234567890',
  },
  rt: {
    test: (v) => /^\d{9}$/.test(String(v).trim()),
    message: 'Routing number must be exactly 9 digits.',
    example: '021000021',
  },
  date: {
    test: (v) => {
      const s = String(v).trim();
      let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      let y, mo, d;
      if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
      else {
        m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (!m) return false;
        mo = +m[1]; d = +m[2]; y = +m[3];
      }
      if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
      const dt = new Date(y, mo - 1, d);
      return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
    },
    message: 'Enter a real calendar date (MM/DD/YYYY or YYYY-MM-DD).',
    example: '12/31/2026',
  },
  state: {
    test: (v) => {
      const s = String(v).trim();
      return US_STATES.has(s.toUpperCase()) || US_STATE_NAMES.has(s.toLowerCase());
    },
    message: 'Enter a valid US state (2-letter code or full name).',
    example: 'CA',
  },
  zip: {
    test: (v) => /^\d{5}(-\d{4})?$/.test(String(v).trim()),
    message: 'Enter a valid US ZIP code (5 digits or ZIP+4).',
    example: '90210',
  },
  number: {
    test: (v) => v !== '' && v !== null && !isNaN(Number(v)),
    message: 'Enter a number.',
    example: '1500',
  },
};

// Type → implied validator (so the generator can just pick a type).
const TYPE_VALIDATOR = { email: 'email', phone: 'phone', date: 'date', number: 'number' };

function resolveValidator(field) {
  return field.validate || TYPE_VALIDATOR[field.type] || null;
}

// Validate a single scalar value against a field. Returns { ok, message }.
function validateValue(field, value) {
  const empty = value === '' || value === null || value === undefined;
  if (empty) {
    if (field.required) return { ok: false, message: `${field.label} is required.` };
    return { ok: true };
  }
  const vName = resolveValidator(field);
  if (vName && VALIDATORS[vName]) {
    const v = VALIDATORS[vName];
    if (!v.test(value)) return { ok: false, message: v.message };
  }
  return { ok: true };
}

// Emit the validator table as browser-ready JS source (functions inlined).
function clientSource() {
  const entries = Object.entries(VALIDATORS).map(
    ([name, v]) =>
      `  ${JSON.stringify(name)}: { test: ${v.test.toString()}, message: ${JSON.stringify(
        v.message
      )}, example: ${JSON.stringify(v.example)} }`
  );
  return `const VALIDATORS = {\n${entries.join(',\n')}\n};\n` +
    `const TYPE_VALIDATOR = ${JSON.stringify(TYPE_VALIDATOR)};`;
}

module.exports = {
  FIELD_TYPES,
  VALIDATORS,
  TYPE_VALIDATOR,
  resolveValidator,
  validateValue,
  clientSource,
};
