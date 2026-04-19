// thread.js
//
// GET /api/thread?thread=<thread-id>
//
// Returns all agent-messages in a thread, sorted chronologically.
// This is Chaos's getThread() as a real endpoint.
//
// The endpoint queries the `memories` collection for:
//   - category = 'agent-message'
//   - tags contains 'thread:<thread-id>'
// Sorted by key timestamp (which embeds ISO time) ascending.
//
// Each message is returned with parsed META + BODY so clients
// don't have to reparse the stored format.

const { getDb, auth, cors } = require('./_lib/auth');
const { parseMessageValue } = require('./_lib/federation');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await auth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { thread, limit = '100' } = req.query;
  if (!thread) return res.status(400).json({ error: 'thread parameter required' });

  // Thread format: <topic>-<YYYY-MM-DD>
  if (!/^[a-z0-9_-]+-\d{4}-\d{2}-\d{2}$/.test(thread)) {
    return res.status(400).json({ error: 'thread must match <topic>-<YYYY-MM-DD>' });
  }

  try {
    const db = await getDb();

    // Find agent-messages tagged with this thread belonging to the requesting user.
    // (Federation messages may carry multiple users' perspectives, but ownership
    // of the message store is always the user who wrote it.)
    const messages = await db.collection('memories').find({
      userId: user._id,
      category: 'agent-message',
      tags: { $regex: `thread:${thread}(,|$)` }
    })
    .sort({ key: 1 }) // key embeds ISO timestamp — ascending = chronological
    .limit(Math.min(parseInt(limit), 500))
    .toArray();

    // Parse each message value into META + BODY for client convenience.
    const rendered = messages.map(m => {
      const parsed = parseMessageValue(m.value);
      return {
        key: m.key,
        category: m.category,
        tags: m.tags,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        version_count: m.version_count,
        last_event_id: m.last_event_id,
        meta: parsed ? parsed.meta : null,
        body: parsed ? parsed.body : m.value,
        parse_ok: !!parsed,
      };
    });

    return res.json({
      thread,
      count: rendered.length,
      messages: rendered,
    });
  } catch (error) {
    console.error('Thread error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};
