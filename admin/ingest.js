// admin/ingest.js
// POST /api/admin/ingest — founder-only cross-user ingest.
//
// Same shape as POST /api/ingest, plus a required `target` field selecting the
// destination user (by email, user_id, or apiKey). Founder-tier Bearer auth
// required.  Returns the same response shape as /api/ingest, plus an `admin`
// echo identifying caller and resolved target.
//
// This is the explicit boundary-crossing endpoint.  /api/ingest stays
// single-owner (authenticated user → that user's pool).  Cross-user writes go
// through here, gated on founder tier, with target resolution in one place,
// and each object is tagged with metadata.admin_ingest so it's auditable later.

const { getDb, auth, cors, ObjectId } = require('../_lib/auth');
const { putObject } = require('../_lib/objects');

module.exports = async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Founder-tier check.
  const caller = await auth(req);
  if (!caller) return res.status(401).json({ error: 'Unauthorized' });
  if (caller.tier !== 'founder') return res.status(403).json({ error: 'Forbidden — founder tier required' });

  // Validate body.
  const body = req.body || {};
  const { content, source_type, target } = body;
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'content required (string)' });
  }
  if (!source_type || typeof source_type !== 'string') {
    return res.status(400).json({ error: 'source_type required (string)' });
  }
  if (!target || typeof target !== 'object') {
    return res.status(400).json({ error: 'target required (object with email | user_id | apiKey)' });
  }

  // Resolve target user.
  const db = await getDb();
  const users = db.collection('users');
  let targetUser = null;
  if (target.user_id) {
    try {
      targetUser = await users.findOne({ _id: new ObjectId(target.user_id) });
    } catch (e) {
      return res.status(400).json({ error: 'invalid user_id' });
    }
  } else if (target.email) {
    targetUser = await users.findOne({ email: target.email });
  } else if (target.apiKey) {
    targetUser = await users.findOne({ apiKey: target.apiKey });
  } else {
    return res.status(400).json({ error: 'target must include email, user_id, or apiKey' });
  }
  if (!targetUser) return res.status(404).json({ error: 'target user not found' });

  // Tag the object so it's auditable as cross-user.
  const adminMetadata = {
    admin_ingest: {
      caller_user_id: caller._id.toString(),
      caller_email: caller.email,
      at: new Date().toISOString(),
    },
    ...(body.metadata && typeof body.metadata === 'object' ? body.metadata : {}),
  };

  // Write to target user's pool.
  const result = await putObject(db, targetUser._id, {
    content,
    source_type,
    source: body.source,
    speaker: body.speaker,
    session_id: body.session_id,
    turn_index: body.turn_index,
    trace_id: body.trace_id,
    client: body.client,
    metadata: adminMetadata,
    client_timestamp: body.client_timestamp,
  });

  return res.status(result.duplicate ? 200 : 201).json({
    object_id: result.object_id,
    ingested_at: new Date().toISOString(),
    stored: true,
    embedded: result.status === 'embedded',
    status: result.status,
    chunk_count: result.chunk_count,
    duplicate: !!result.duplicate,
    retry_pending: !!result.retry_pending,
    provenance: result.provenance,
    admin: {
      caller_user_id: caller._id.toString(),
      target_user_id: targetUser._id.toString(),
      target_email: targetUser.email,
    },
  });
};
