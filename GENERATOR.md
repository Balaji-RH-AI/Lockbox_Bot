# Questionnaire → Prompt Generator

Turn **any** questionnaire (Word, PDF, or pasted text) into a working conversational
chatbot — system prompt, extraction schema, and interactive UI cards — without writing
any per-form code.

## Quick start

```bash
npm install
npm start            # http://localhost:5000
```

| Page | What it does |
|------|--------------|
| **`/generator`** | Upload a Word/PDF (or paste text) → generate a form definition. Preview cards, system prompt, extraction schema, and the rendered `prompts.js`. Download or set as the active form. |
| **`/run`** | Generic chat runtime that renders whatever form is currently active. Ships with a seeded **IT Support Request** demo. |
| **`/`** | The original Lockbox bot (unchanged). Used automatically when no generated form is active. |

The generator reuses the Azure OpenAI credentials already in `.env`
(`AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_DEPLOYMENT`).

## How it works

Everything is driven by one artifact — a **form definition** stored in `forms/<id>.json`:

```jsonc
{
  "meta":            { "id", "title", "version", "generatedAt" },
  "systemPrompt":    "<conversation instructions for the assistant>",
  "extractionSchema": { /* JSON shape used by Export JSON */ },
  "cards": [
    {
      "id": "primary_contact",
      "title": "Primary Contact",
      "intro": "Please provide the primary contact details.",
      "fields": [
        { "key": "fullName", "label": "Full name", "type": "text", "required": true },
        { "key": "email",    "label": "Email",     "type": "email" },
        { "key": "phone",    "label": "Phone",     "type": "phone" }
      ]
    }
  ]
}
```

The same definition is **both** the generator's output (downloadable as `prompts.js`)
**and** what the live bot executes.

### Pipeline

```
Word/PDF/text ─▶ extractText ─▶ LLM meta-prompt ─▶ form definition ─▶ forms/<id>.json
                 (mammoth /                          (normalized &        │
                  pdf-parse)                          validated)          ▼
                                                              /run renders cards
                                                              from the spec
```

### Field types

`text · textarea · number · email · phone · date · select · multiselect · checkbox · group`

- `select` → radio, `multiselect` → checkboxes, `group` → composite; add `"repeat": true`
  to a group for repeating rows (e.g. "list each contact").
- `showIf: { field, equals }` conditionally reveals a field.

### Validators

Built in and applied automatically: `email · phone · dda · rt · date · state · zip · number`.
A field can set `"validate": "rt"` explicitly; otherwise the generator **infers** a
validator from the field's name (e.g. "routing #" → `rt`, "ZIP" → `zip`). Validation runs
in the browser before submit and again server-side during extraction.

## Source layout

| File | Role |
|------|------|
| [src/cardTypes.js](src/cardTypes.js) | Single source of truth for field types + validators; emits browser-ready validator JS |
| [src/generator.js](src/generator.js) | Document text extraction + LLM meta-prompt → form definition (with deterministic normalization) |
| [src/formDef.js](src/formDef.js) | Stores/loads definitions, tracks the active form, renders `prompts.js` |
| [src/extract.js](src/extract.js) | Resolves the active prompt/schema (falls back to legacy `prompts.js`) and runs Export JSON |
| [templates/generator.html](templates/generator.html) | Generator web UI |
| [templates/run.html](templates/run.html) | One generic, data-driven card renderer for any form |

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/generate` | multipart `file` and/or `{ text, title, activate }` → form definition |
| `GET`  | `/api/forms` | list stored forms + active id |
| `POST` | `/api/forms/active` | `{ id }` → set the active form |
| `GET`  | `/api/form` | active form's cards + meta + validator source (used by `/run`) |
| `GET`  | `/api/form/prompts.js` | download a form rendered as a `prompts.js` module |
| `GET`  | `/api/form/definition.json` | download the raw definition |

## Reliability notes

`normalizeDefinition` makes generated output robust regardless of model variance:
- Every card is **guaranteed** an operational `[FORM_CARD:<id>]` tag in the system prompt
  (a fallback instruction block is appended for any the model omitted) — the runtime
  cannot show a card otherwise.
- Missing validators are inferred from field semantics.
- Card ids are sanitized; malformed responses are coerced into a runnable shape.
