// Build the help-bot knowledge index from the docs/ folder.
// Run:  node scripts/build-help-index.js
//
// Requires AZURE_EMBED_DEPLOYMENT (an Azure embeddings deployment, e.g. text-embedding-3-small).

require('dotenv').config();
const { buildIndex, DOCS_DIR } = require('../src/helpDocs');

(async () => {
  try {
    console.log('Building help index from:', DOCS_DIR);
    const r = await buildIndex();
    console.log(`✓ Indexed ${r.chunks} chunks from ${r.files} file(s).`);
  } catch (e) {
    console.error('✗ Build failed:', e.message);
    process.exit(1);
  }
})();
