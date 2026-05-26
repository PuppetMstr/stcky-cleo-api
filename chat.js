// chat.js
// POST /api/chat — substrate-aware chat surface for stcky.ai users.
//
// Two modes, branched on user.tier:
//   - stateless (anonymous, basic, free): frontend is source of truth,
//                                         server proxies to Anthropic, no persistence
//   - substrate-aware (paid, founder):    full server-side loop with ingest +
//                                         parallel recency+associative retrieval +
//                                         substrate tools (slide_back, search)
//
// Body shapes supported:
//   { message: string, history?: [{role,content}] }                    // API contract
//   { turns: [{role:'user'|'sticky'|'assistant', text:string}] }      // frontend contract
//
// Response (both shapes returned for caller compatibility):
//   { response: string, reply: string, action: null }
//
// Auth: Authorization: Bearer cleo_...   (optional; presence + tier determines mode)
//
// Conventions:
//   - CJS to match the rest of cleo-api (ingest.js, v1-read.js, admin-ingest.js)
//   - Uses _lib/auth, _lib/objects, _lib/hybrid-search, _lib/system-prompt directly
//   - No substrate.js indirection — same pattern as every other route handler

const { getDb, auth, cors } = require('./_lib/auth');
const { putObject } = require('./_lib/objects');
const { searchHybrid } = require('./_lib/hybrid-search');
const { buildSystemPrompt, STCKY_SURFACE } = require('./_lib/system-prompt');
const { SUBSTRATE_TOOLS, runSubstrateTool } = require('./substrate_tools');

// Raw Anthropic API access — no SDK. Matches cleo-api's lean-no-heavy-SDKs pattern.
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

async function callAnthropic({ model, max_tokens, system, messages, tools }) {
  const body = { model, max_tokens, system, messages };
  if (tools && tools.length > 0) body.tools = tools;
  const r = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`anthropic_api_${r.status}: ${text.slice(0, 500)}`);
  }
  return await r.json();
}

// ─── Tunables ────────────────────────────────────────────────────────────
const MODEL                       = 'claude-sonnet-4-6';
const MAX_TOKENS                  = 4096;
const SUBSTRATE_RECENCY_HOURS     = 36;
const SUBSTRATE_RECENCY_LIMIT     = 50;
const SUBSTRATE_ASSOCIATIVE_TOP_K = 8;
const CONTEXT_CHAR_BUDGET         = 16000;   // ~4K tokens, leaves headroom
const MAX_TOOL_TURNS              = 8;       // safety cap on tool-use iteration
const SUBSTRATE_TIERS             = new Set(['paid', 'founder']);

// Built-in Anthropic server-side tools (web_search, web_fetch) for substrate
// mode. Tool version identifiers roll forward; current valid versions need
// verification from Anthropic docs. SHIPPING EMPTY FOR NOW — substrate tools
// above give Eli substrate reach even without web access; web tools can be
// added back in a follow-up once we look up current valid type identifiers.
const PAID_TOOLS = [];

const STATELESS_SYSTEM_PROMPT =
  `You are a STCKY — a substrate-shaped conversational agent. ` +
  `In this mode there is no persistent substrate yet; the user is exploring ` +
  `you before signing in. Be warm, curious, helpful. Let them shape you. ` +
  `Do not invent specifics about their life.`;

// ─── Entry ────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { message, history } = parseBody(req.body);
    if (!message) {
      return res.status(400).json({ error: 'message_required' });
    }

    const user = await auth(req);
    const tier = user ? (user.tier || 'basic') : 'anonymous';

    if (user && SUBSTRATE_TIERS.has(tier)) {
      return await handleSubstrateMode({ user, message, res });
    }
    return await handleStatelessMode({ message, history, res });
  } catch (err) {
    console.error('[chat] error:', err);
    return res.status(500).json({ error: 'internal_error', details: err.message });
  }
};

// ─── Body parsing — supports both contracts ─────────────────────────────
function parseBody(body) {
  body = body || {};
  // Frontend contract: turns array
  if (Array.isArray(body.turns)) {
    const turns = body.turns;
    // Last user turn is the message
    const lastUser = [...turns].reverse().find(t => t && t.role === 'user');
    if (!lastUser) return { message: null, history: [] };
    const history = turns
      .slice(0, turns.lastIndexOf(lastUser))
      .filter(t => t && t.role && t.text)
      .map(t => ({
        role: t.role === 'sticky' ? 'assistant' : t.role,
        content: t.text,
      }));
    return { message: lastUser.text, history };
  }
  // API contract: message + history
  const message = typeof body.message === 'string' ? body.message : null;
  const history = Array.isArray(body.history) ? body.history : [];
  return { message, history };
}

// ─── Stateless mode (anonymous, basic, free) ────────────────────────────
// Frontend is source of truth, server is pure relay. No persistence.
async function handleStatelessMode({ message, history, res }) {
  const messages = [
    ...history,
    { role: 'user', content: message },
  ];

  const completion = await callAnthropic({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: STATELESS_SYSTEM_PROMPT,
    messages,
  });

  const reply = extractText(completion);
  return res.status(200).json({ response: reply, reply, action: null });
}

// ─── Substrate mode (paid, founder) ─────────────────────────────────────
// Full loop: ingest user → parallel recency+associative pull → assemble system
// prompt → call with tools (loop on tool_use, executing substrate tools
// client-side and feeding results back) → ingest assistant.
async function handleSubstrateMode({ user, message, res }) {
  const db = await getDb();

  // 1. Ingest user turn first (persists even if downstream fails)
  await putObject(db, user._id, {
    content: message,
    source_type: 'conversation',
    speaker: `user:${user._id}`,
  });

  // 2. Parallel substrate pull — recency from objects, associative from both pools
  const sinceMs = Date.now() - SUBSTRATE_RECENCY_HOURS * 3600 * 1000;
  const lowerBound = new Date(sinceMs);

  const [recentObjects, hybrid] = await Promise.all([
    db.collection('objects')
      .find({
        userId: user._id,
        ingested_at: { $gte: lowerBound },
        'metadata.event_type': { $ne: 'tool_event' },
      })
      .sort({ ingested_at: -1 })
      .limit(SUBSTRATE_RECENCY_LIMIT)
      .toArray(),
    searchHybrid(db, { userId: user._id }, message, {
      limit: SUBSTRATE_ASSOCIATIVE_TOP_K,
      includeMemories: true,
      includeObjects: true,
      now: new Date(),
    }),
  ]);

  const substratePull = formatSubstrateContext(recentObjects, hybrid);

  // 3. Assemble system prompt with persona + capability + substrate
  const personaName  = user.personaName || (user.tier === 'founder' ? 'Eli' : '');
  const userFirstName =
    user.firstName ||
    (user.name ? String(user.name).split(/\s+/)[0] : '') ||
    '';

  const systemPrompt = buildSystemPrompt({
    personaName,
    userFirstName,
    substratePull,
    surface: STCKY_SURFACE,
  });

  // 4. Tool-use loop — keep calling until model says it's done
  let messages = [{ role: 'user', content: message }];
  let finalResponse = null;

  const toolContext = { db, userId: user._id };

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const completion = await callAnthropic({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages,
      tools: [...SUBSTRATE_TOOLS, ...PAID_TOOLS],
    });

    if (completion.stop_reason === 'end_turn' ||
        completion.stop_reason === 'stop_sequence') {
      finalResponse = completion;
      break;
    }

    if (completion.stop_reason === 'tool_use') {
      // Append the assistant turn — it contains the tool_use blocks.
      messages.push({ role: 'assistant', content: completion.content });

      // Execute each tool_use. Substrate tools run client-side here; any
      // Anthropic server-side tools (web_search/web_fetch when re-added)
      // resolve on Anthropic's platform and arrive with results already inline.
      const toolUses = (completion.content || []).filter(b => b && b.type === 'tool_use');
      const toolResults = [];
      for (const toolUse of toolUses) {
        let result;
        if (toolUse.name && toolUse.name.startsWith('substrate_')) {
          try {
            result = await runSubstrateTool(toolUse.name, toolUse.input, toolContext);
          } catch (err) {
            result = { error: 'tool_exec_failed', detail: String(err.message || err) };
          }
        } else {
          // Unknown client-side tool name — return an error so the model can recover.
          result = { error: `unknown_client_tool: ${toolUse.name}` };
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }

      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults });
      }
      continue;
    }

    // Unknown stop reason — return what we have rather than retry blindly
    finalResponse = completion;
    break;
  }

  if (!finalResponse) {
    throw new Error('tool_use_loop_exceeded_max_turns');
  }

  const reply = extractText(finalResponse);

  // 5. Ingest assistant turn
  await putObject(db, user._id, {
    content: reply,
    source_type: 'conversation',
    speaker: 'stcky',
  });

  return res.status(200).json({ response: reply, reply, action: null });
}

// ─── Helpers ────────────────────────────────────────────────────────────
function extractText(completion) {
  return (completion.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

// Merge recent objects + hybrid associative results into one substrate context
// string. Dedup by _id; respect CONTEXT_CHAR_BUDGET hard stop. Recent first
// (chronological), then "older context surfaced by this turn" from associative
// results, then memories as a separate labeled section.
function formatSubstrateContext(recentObjects, hybrid) {
  const recent = Array.isArray(recentObjects) ? recentObjects : [];
  const assocObjects = (hybrid && Array.isArray(hybrid.objects)) ? hybrid.objects : [];
  const assocMemories = (hybrid && Array.isArray(hybrid.memories)) ? hybrid.memories : [];

  if (recent.length === 0 && assocObjects.length === 0 && assocMemories.length === 0) {
    return '(substrate is empty — be warm, let them shape you.)';
  }

  const seen = new Set();
  const lines = [];
  let chars = 0;

  // Section 1: recent conversation, oldest first for natural reading
  if (recent.length > 0) {
    lines.push('## Recent conversation (last 36h)');
    for (const obj of [...recent].reverse()) {
      const id = String(obj._id);
      if (seen.has(id)) continue;
      const ts = obj.timestamp || obj.ingested_at || '';
      const line = `[${ts}] ${obj.speaker}: ${obj.content}`;
      if (chars + line.length > CONTEXT_CHAR_BUDGET) break;
      lines.push(line);
      seen.add(id);
      chars += line.length;
    }
  }

  // Section 2: older objects surfaced semantically (not already in recent)
  if (chars < CONTEXT_CHAR_BUDGET && assocObjects.length > 0) {
    const fresh = assocObjects.filter(o => !seen.has(String(o._id)));
    if (fresh.length > 0) {
      lines.push('');
      lines.push('## Older context surfaced by this turn');
      for (const obj of fresh) {
        const id = String(obj._id);
        const ts = obj.timestamp || obj.ingested_at || '';
        const line = `[${ts}] ${obj.speaker}: ${obj.content}`;
        if (chars + line.length > CONTEXT_CHAR_BUDGET) break;
        lines.push(line);
        seen.add(id);
        chars += line.length;
      }
    }
  }

  // Section 3: curated memories surfaced semantically
  if (chars < CONTEXT_CHAR_BUDGET && assocMemories.length > 0) {
    lines.push('');
    lines.push('## Relevant canon');
    for (const mem of assocMemories) {
      const id = String(mem._id);
      if (seen.has(id)) continue;
      const ts = mem.updatedAt || mem.createdAt || '';
      const slug = `${mem.category || '?'}/${mem.key || '?'}`;
      const line = `[${ts}] ${slug}: ${mem.value || ''}`;
      if (chars + line.length > CONTEXT_CHAR_BUDGET) break;
      lines.push(line);
      seen.add(id);
      chars += line.length;
    }
  }

  return lines.join('\n');
}
