const { getDb, auth, cors, ObjectId } = require('./_lib/auth');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await auth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const db = await getDb();
  const sessions = db.collection('sessions');

  try {
    if (req.method === 'POST') {
      const { tags } = req.body;
      const session = {
        userId: user._id,
        status: 'in_progress',
        tags: tags || '',
        summary: '',
        decisions: '',
        pending: '',
        startedAt: new Date(),
        endedAt: null
      };
      const result = await sessions.insertOne(session);
      return res.status(200).json({ success: true, sessionId: result.insertedId.toString(), message: 'Session started' });
    }

    if (req.method === 'PUT') {
      const { sessionId, summary, decisions, pending } = req.body;
      if (!sessionId || !summary) return res.status(400).json({ error: 'sessionId and summary required' });

      await sessions.updateOne(
        { _id: new ObjectId(sessionId), userId: user._id },
        { $set: { status: 'completed', summary: summary || '', decisions: decisions || '', pending: pending || '', endedAt: new Date() } }
      );
      return res.status(200).json({ success: true, message: 'Session ended' });
    }

    if (req.method === 'GET') {
      const { limit = '5' } = req.query;
      const results = await sessions.find({ userId: user._id }).sort({ startedAt: -1 }).limit(parseInt(limit)).toArray();
      return res.status(200).json({ sessions: results, count: results.length });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Sessions error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
