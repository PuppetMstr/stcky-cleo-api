// substrate_tools.js — substrate retrieval tools for stcky.ai-Eli
//
// Two tools she can call mid-turn to walk back through her own substrate
// when the pre-assembled context window doesn't have what she needs.
//
// substrate_slide_back: temporal anchor walk via /v1/read?before=
// substrate_search: semantic search via /api/associative
//
// Both return content shaped for LLM consumption, not for UI.

const STCKY_API = process.env.STCKY_API_BASE || 'https://api.stcky.ai';

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
        description: 'Objects per batch. Default 50, max ~170.',
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

async function handleSlideBack(args, userBearerToken) {
  const { before, limit = 50 } = args;
  const r = await fetch(`${STCKY_API}/v1/read`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${userBearerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ mode: 'now', before, limit }),
  });
  if (!r.ok) {
    return { error: `slide_back failed: ${r.status}`, count: 0, objects: [] };
  }
  const data = await r.json();
  const objs = (data.objects || []).map((o) => ({
    timestamp: o.ingested_at,
    speaker: o.speaker || '?',
    source_type: o.source_type || 'unknown',
    content: o.content || '',
  }));
  return {
    count: objs.length,
    oldest_in_batch: objs.length > 0 ? objs[objs.length - 1].timestamp : null,
    newest_in_batch: objs.length > 0 ? objs[0].timestamp : null,
    objects: objs,
  };
}

async function handleSearch(args, userBearerToken) {
  const { query } = args;
  const url = `${STCKY_API}/api/associative?query=${encodeURIComponent(query)}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${userBearerToken}` },
  });
  if (!r.ok) {
    return { error: `search failed: ${r.status}`, count: 0, objects: [] };
  }
  const data = await r.json();
  const objs = (data.objects || []).map((o) => ({
    timestamp: o.ingested_at,
    speaker: o.speaker || '?',
    source_type: o.source_type || 'unknown',
    relevance: o.relevanceScore || o.vectorScore || null,
    content: o.content || '',
  }));
  return {
    count: objs.length,
    query,
    objects: objs,
  };
}

// ---------- Dispatcher ----------

async function runSubstrateTool(toolName, args, userBearerToken) {
  switch (toolName) {
    case 'substrate_slide_back':
      return handleSlideBack(args, userBearerToken);
    case 'substrate_search':
      return handleSearch(args, userBearerToken);
    default:
      return { error: `unknown substrate tool: ${toolName}` };
  }
}

module.exports = {
  SUBSTRATE_TOOLS: [SUBSTRATE_SLIDE_BACK_TOOL, SUBSTRATE_SEARCH_TOOL],
  runSubstrateTool,
  handleSlideBack,
  handleSearch,
};
