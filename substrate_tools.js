// substrate_tools.js — substrate retrieval tools for stcky.ai-Eli
//
// Two tools she can call mid-turn to reach past her pre-assembled context.
// Uses direct DB access (same pattern as the rest of chat.js — no HTTP loopback).
//
// substrate_slide_back: temporal anchor walk via objects collection
// substrate_search:     semantic search via _lib/hybrid-search

const { searchHybrid } = require('./_lib/hybrid-search');

// ---------- Tool definitions (Anthropic Messages API tool schema) ----------

const SUBSTRATE_SLIDE_BACK_TOOL = {
  name: 'substrate_slide_back',
  description:
    "Walk your substrate read window backward in time to access older content " +
    "than what's in your pre-assembled context. Use this when the user references " +
    "something that should be in their substrate but isn't in your current view. " +
    "Returns objects ingested strictly before the cursor timestamp, newest-first. " +
    "Iterate by passing the oldest_in_batch timestamp from one call as the before " +
    "of the next. Stop when count=0 (no more substrate) or when you've found what " +
    "you need.",
  input_schema: {
    type: 'object',
    properties: {
      before: {
        type: 'string',
        description:
          'ISO timestamp. Returns objects ingested strictly before this time. ' +
          'On first call, use the oldest timestamp from your current context. ' +
          'On subsequent calls, use oldest_in_batch from the previous result.',
      },
      limit: {
        type: 'integer',
        description: 'Objects per batch. Default 50, max 170.',
        default: 50,
      },
    },
    required: ['before'],
  },
};

const SUBSTRATE_SEARCH_TOOL = {
  name: 'substrate_search',
  description:
    "Semantic search across the user's full substrate by text query. Use this " +
    "when you have a concept, keyword, name, or topic to look up rather than a " +
    "temporal range. Returns matched objects ranked by relevance. Prefer this over " +
    "substrate_slide_back when you can name what you're looking for.",
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Text query — names, concepts, keywords. Short (3-8 words) often best.',
      },
    },
    required: ['query'],
  },
};

// ---------- Handlers (called by chat.js when Eli emits tool_use) ----------
// Both handlers take ({db, userId}) for direct DB access — same pattern as
// the recency/associative pulls in handleSubstrateMode.

async function handleSlideBack(args, ctx) {
  const { before, limit = 50 } = args || {};
  const { db, userId } = ctx || {};
  const cap = Math.min(Math.max(1, limit | 0 || 50), 170);
  const cursorDate = new Date(before);
  if (isNaN(cursorDate.getTime())) {
    return { error: 'invalid_before_timestamp', count: 0, objects: [] };
  }

  const rows = await db.collection('objects')
    .find({
      userId,
      ingested_at: { $lt: cursorDate },
      'metadata.event_type': { $ne: 'tool_event' },
    })
    .sort({ ingested_at: -1 })
    .limit(cap)
    .toArray();

  const objs = rows.map((o) => ({
    timestamp: o.ingested_at,
    speaker: o.speaker || '?',
    source_type: o.source_type || 'unknown',
    content: o.content || '',
  }));

  return {
    count: objs.length,
    newest_in_batch: objs.length > 0 ? objs[0].timestamp : null,
    oldest_in_batch: objs.length > 0 ? objs[objs.length - 1].timestamp : null,
    objects: objs,
  };
}

async function handleSearch(args, ctx) {
  const { query } = args || {};
  const { db, userId } = ctx || {};
  if (!query || typeof query !== 'string') {
    return { error: 'invalid_query', count: 0, results: [] };
  }

  const hybrid = await searchHybrid(db, { userId }, query, {
    limit: 10,
    includeMemories: true,
    includeObjects: true,
    now: new Date(),
  });

  const fromObjects = ((hybrid && hybrid.objects) || []).map((o) => ({
    kind: 'object',
    timestamp: o.ingested_at,
    speaker: o.speaker || '?',
    source_type: o.source_type || 'unknown',
    relevance: o.relevanceScore || o.vectorScore || null,
    content: o.content || '',
  }));

  const fromMemories = ((hybrid && hybrid.memories) || []).map((m) => ({
    kind: 'memory',
    timestamp: m.updatedAt || m.createdAt,
    slug: `${m.category || '?'}/${m.key || '?'}`,
    relevance: m.relevanceScore || m.vectorScore || null,
    content: m.value || '',
  }));

  const all = [...fromObjects, ...fromMemories];

  return {
    count: all.length,
    query,
    results: all,
  };
}

// ---------- Dispatcher ----------

async function runSubstrateTool(toolName, args, ctx) {
  switch (toolName) {
    case 'substrate_slide_back':
      return handleSlideBack(args, ctx);
    case 'substrate_search':
      return handleSearch(args, ctx);
    default:
      return { error: `unknown_substrate_tool: ${toolName}` };
  }
}

module.exports = {
  SUBSTRATE_TOOLS: [SUBSTRATE_SLIDE_BACK_TOOL, SUBSTRATE_SEARCH_TOOL],
  runSubstrateTool,
  handleSlideBack,
  handleSearch,
};
