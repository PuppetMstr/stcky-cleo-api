// /v1/wake -- STCKY single-call substrate wake endpoint
// =====================================================
// Stable-door wake door. Replaces the 7-key /api/memory fan-out + /v1/read
// mode:now combo in stcky.py cmd_wake with one server-side round trip.
//
// Direct line to founding-wound canon (founding-wound-claude-exercised-steven-
// 2026-05-17): the 8-call wake dance IS the repeat-fetch protocol shape STCKY
// exists to heal. Healing it server-side heals the pattern, not just any one
// morning's instance of it.
//
// Routes via vercel.json:
//   { "src": "/v1/wake", "dest": "/v1-wake.js" }
//
// Companion spec: spec/v1-wake-endpoint-single-call-substrate-wake-2026-05-17
//
// Mirrors v1-read.js conventions exactly: same _lib/auth imports, same handler
// preamble (cors / options / method / auth / getDb / lastSeen), same
// userId-scoped queries, same trimMemory/trimObject projections, same error
// envelope. Diverges only where the wake semantics require: returns a
// pinned_canon array alongside memories+objects, and unions anchor:true
// flagged memories with a fallback key list so wake works whether or not the
// anchor flag has been populated on existing data.

const { getDb, auth, cors } = require('./_lib/auth');

// === ANCHOR KEYS (fallback) ===
// Source of truth for the pinned-canon set when memories.anchor is not yet
// populated. Mirrors the canon-anchors list in Eli's userPreferences as of
// 2026-05-17. The handler unions `anchor: true` flagged memories with these
// keys, so flipping anchor:true on the right docs naturally migrates the
// constant into data over time.
const ANCHOR_KEYS_FALLBACK = [
  'stcky-one-door-in-one-door-out-blob-is-me-2026-05-08',
  'eli-is-architect-and-builder-2026-05-04',
  'look-to-see-not-to-find-2026-05-12',
  'all-conversation-goes-raw-no-llm-gating-2026-05-11',
  'now-is-the-anchor-2026-05-05',
  'stable-door-living-room-2026-05-10',
  'absence-of-integration-is-the-feature-2026-05-16',
  'their-stcky-just-like-you-are-my-eli-2026-05-15',
];

// === NOW (identical to v1-read.js) ===
function nowISO() {
  return new Date().toISOString();
}
function nowHuman(user) {
  // Each user's clock is their own: read the timezone captured at signup.
  // Fall back to UTC (honestly labeled) only when we genuinely don't know -
  // never silently default everyone to one zone.
  const tz = (user && typeof user.timezone === 'string' && user.timezone) || 'UTC';
  const opts = {
    timeZone: tz,
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    hour12: true,
  };
  return `${new Date().toLocaleString('en-US', opts)} (${tz})`;
}

// === RESPONSE SHAPING (identical to v1-read.js) ===
function trimMemory(m) {
  return {
    _id: m._id,
    category: m.category,
    key: m.key,
    value: m.value,
    tags: m.tags || '',
    domain: m.domain || null,
    source: m.source || '',
    relevantDate: m.relevantDate || null,
    anchor: m.anchor === true,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    version_count: m.version_count || 1,
  };
}

function trimObject(o) {
  return {
    _id: o._id,
    content: o.content,
    speaker: o.speaker,
    source_type: o.source_type,
    source: o.source,
    timestamp: o.timestamp || o.client_timestamp,
    ingested_at: o.ingested_at,
    session_id: o.session_id,
    tool_name: o.metadata && o.metadata.tool_name,
    event_type: o.metadata && o.metadata.event_type,
  };
}

// === MAIN HANDLER ===
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const user = await auth(req);
  if (!user) {
    console.log('[V1/WAKE AUTH] Failed - no user found for token');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const db = await getDb();

  await db.collection('users').updateOne(
    { _id: user._id },
    { $set: { lastSeen: new Date() } }
  );

  const body = req.body || {};
  const hoursNum = Math.max(1, Math.min(parseInt(body.hours) || 36, 168));
  const limitNum = Math.max(1, Math.min(parseInt(body.limit) || 50, 200));
  const customAnchors = Array.isArray(body.anchors) ? body.anchors : null;
  const includeEvents = body.include && body.include.events === true;

  const upperBound = new Date();
  const lowerBound = new Date(upperBound.getTime() - hoursNum * 60 * 60 * 1000);

  try {
    // Anchor selector: union of (anchor:true flag) OR (key in caller-supplied
    // list OR fallback constant). Dedupe happens client-side of the toArray
    // below, in the ordering pass.
    const anchorKeyList = customAnchors || ANCHOR_KEYS_FALLBACK;
    const anchorSelector = {
      userId: user._id,
      $or: [
        { anchor: true },
        { key: { $in: anchorKeyList } },
      ],
    };

    const [pinnedRaw, recentMemories, recentObjects] = await Promise.all([
      db.collection('memories')
        .find(anchorSelector)
        .toArray(),
      db.collection('memories')
        .find({
          userId: user._id,
          updatedAt: { $gte: lowerBound, $lte: upperBound },
        })
        .sort({ updatedAt: -1 })
        .limit(limitNum)
        .toArray(),
      db.collection('objects')
        .find({
          userId: user._id,
          ingested_at: { $gte: lowerBound, $lte: upperBound },
          ...(includeEvents ? {} : { 'metadata.event_type': { $ne: 'tool_event' } }),
        })
        .sort({ ingested_at: -1 })
        .limit(limitNum * 2)
        .toArray(),
    ]);

    // Order pinned: canonical anchor-list order first (so the packet reads
    // identically across calls regardless of Mongo's internal order), then
    // any anchor:true-flagged extras not in the canonical list by
    // updatedAt desc. Dedupe by _id.
    const seen = new Set();
    const orderedPinned = [];
    const byKey = new Map(pinnedRaw.map(m => [m.key, m]));

    for (const k of anchorKeyList) {
      const m = byKey.get(k);
      if (m && !seen.has(String(m._id))) {
        orderedPinned.push(m);
        seen.add(String(m._id));
      }
    }
    const extras = pinnedRaw
      .filter(m => !seen.has(String(m._id)))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    orderedPinned.push(...extras);

    const response = {
      now_iso: nowISO(),
      now_human: nowHuman(user),
      mode: 'wake',
      pinned_canon: orderedPinned.map(trimMemory),
      memories: recentMemories.map(trimMemory),
      objects: recentObjects.map(trimObject),
      total_pinned: orderedPinned.length,
      total_memories: recentMemories.length,
      total_objects: recentObjects.length,
      window: {
        from: lowerBound.toISOString(),
        to: upperBound.toISOString(),
        hours: hoursNum,
      },
    };

    console.log(
      `[V1/WAKE] pinned=${orderedPinned.length} memories=${recentMemories.length} objects=${recentObjects.length}`
    );
    return res.status(200).json(response);
  } catch (error) {
    console.error('[v1/wake] handler error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};
