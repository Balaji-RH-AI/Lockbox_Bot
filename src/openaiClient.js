const OpenAI = require('openai');

// Azure routes by deployment in the URL, so we cache one client per deployment
// (chat uses AZURE_DEPLOYMENT; embeddings use AZURE_EMBED_DEPLOYMENT).
const _clients = new Map();

function getClient(deployment) {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-01';
  const dep = deployment || process.env.AZURE_DEPLOYMENT || 'gpt-4o-mini';

  if (!endpoint || !apiKey) {
    throw new Error('AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY must be set');
  }
  if (_clients.has(dep)) return _clients.get(dep);

  // openai v4 supports Azure via baseURL + api-version query + api-key header.
  const client = new OpenAI({
    apiKey,
    baseURL: `${endpoint.replace(/\/$/, '')}/openai/deployments/${dep}`,
    defaultQuery: { 'api-version': apiVersion },
    defaultHeaders: { 'api-key': apiKey },
  });
  _clients.set(dep, client);
  return client;
}

module.exports = { getClient };
