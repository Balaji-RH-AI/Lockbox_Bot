# Help-bot documentation

Drop documentation here for the in-app **Help / Ask** assistant. The customer can chat
with it while filling the questionnaire (e.g. "What is a DDA?", "Wholesale vs Wholetail?").

## Layout
- `docs/*.md|.txt|.docx|.pdf` — **shared** docs, available to every form's help bot.
- `docs/<formId>/*.…` — docs scoped to one form only (e.g. `docs/lockbox-master/`).

## After adding or changing docs
Rebuild the search index (embeddings):

```
node scripts/build-help-index.js
```

This requires `AZURE_EMBED_DEPLOYMENT` in `.env` (an Azure embeddings deployment such as
`text-embedding-3-small`). The index is written to `data/help-index.json`.

The bot answers **only** from these docs; if something isn't covered it says so.
