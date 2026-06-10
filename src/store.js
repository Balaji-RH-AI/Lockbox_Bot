// In-memory conversation store: Map<sid, Array<{role, content}>>
// NOTE: single-instance only. Swap to Redis for scale-out.
const conversations = new Map();

function getHistory(sid) {
  let h = conversations.get(sid);
  if (!h) {
    h = [];
    conversations.set(sid, h);
  }
  return h;
}

function clear(sid) {
  conversations.delete(sid);
}

module.exports = { conversations, getHistory, clear };
