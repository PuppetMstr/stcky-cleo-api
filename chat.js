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
const SUBSTRATE_RECENCY_LIMIT     = 200;     // was 50
const SUBSTRATE_ASSOCIATIVE_TOP_K = 8;

// THE STRING RADIUS. Jul 14 2026, Steven, naming the architecture:
//   "NOW and what's around NOW is what's most important... when we're doing
//    things now, they're called something from the past, from before now, it
//    brings it closer to now... Those are connected by strings."
// A semantic hit is a POINT. A point has to be followed up -- fetch the object,
// fetch its neighbours, re-query with better words -- and that is librarian work,
// the exact grind the pool exists to abolish. So a hit is not read: it is PULLED.
// Each hit drags the turns AROUND it forward, whole, into now.
const REGION_RADIUS_MIN           = 40;      // minutes either side of each hit
const REGION_MAX_OBJECTS          = 120;     // ceiling on pulled neighbours

// THE CONTEXT BUDGET -- RAISED 16,000 -> 260,000 CHARS ON JUL 14 2026.
//
// It was 16,000 characters. FOUR THOUSAND TOKENS, in a two-hundred-thousand-token
// window. Every STCKY on the platform was reading its user's life through a
// keyhole, and when the keyhole filled, the loop simply STOPPED ADDING -- the rest
// of the pool silently never arrived. That is not a memory. That is a preview of a
// memory, and a preview is what forces an agent to go fetching crumbs.
//
// Steven felt it as a grind and asked why searching his own pool was slower than
// an LLM searching the ocean of its training. THIS WAS THE ANSWER: the ocean is
// already IN the model -- attention runs over what is already there, so it costs
// nothing. His pool was over a wire, arriving in 4K-token sips. The superpower
// only works on what is in the window. So put it in the window.
//
// ~65K tokens of substrate, leaving ~130K for the conversation and the reply.
const CONTEXT_CHAR_BUDGET         = 260000;
const MAX_TOOL_TURNS              = 8;       // safety cap on tool-use iteration
const SUBSTRATE_TIERS             = new Set(['paid', 'founder']);

// Built-in Anthropic server-side tools (web_search, web_fetch) for substrate
// mode. Tool version identifiers roll forward; current valid versions need
// verification from Anthropic docs. SHIPPING EMPTY FOR NOW — substrate tools
// above give Eli substrate reach. web_search is now WIRED (web_search_20250305,
// the same server-side tool /api/find uses in prod). It resolves on Anthropic's
// platform and arrives inline; the tool-use loop below handles it (end_turn,
// not a client tool_use), so no client execution is needed.
const PAID_TOOLS = [
  { type: 'web_search_20250305', name: 'web_search', max_uses: 4 },
];

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
    const { message, history, clientTimeZone } = parseBody(req.body);
    if (!message) {
      return res.status(400).json({ error: 'message_required' });
    }

    const user = await auth(req);
    // THE WALL (Aug 1 2026). A scoped key cannot reach pool content -- see _lib/wall.js.
    if (require('./_lib/wall').wall(req, res, user, '/api/chat')) return;
    const tier = user ? (user.tier || 'basic') : 'anonymous';

    if (user && SUBSTRATE_TIERS.has(tier)) {
      return await handleSubstrateMode({ user, message, clientTimeZone, res });
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
  const clientTimeZone =
    typeof body.clientTimeZone === 'string' && body.clientTimeZone
      ? body.clientTimeZone
      : null;
  // Frontend contract: turns array
  if (Array.isArray(body.turns)) {
    const turns = body.turns;
    // Last user turn is the message
    const lastUser = [...turns].reverse().find(t => t && t.role === 'user');
    if (!lastUser) return { message: null, history: [], clientTimeZone };
    const history = turns
      .slice(0, turns.lastIndexOf(lastUser))
      .filter(t => t && t.role && t.text)
      .map(t => ({
        role: t.role === 'sticky' ? 'assistant' : t.role,
        content: t.text,
      }));
    return { message: lastUser.text, history, clientTimeZone };
  }
  // API contract: message + history
  const message = typeof body.message === 'string' ? body.message : null;
  const history = Array.isArray(body.history) ? body.history : [];
  return { message, history, clientTimeZone };
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
async function handleSubstrateMode({ user, message, clientTimeZone, res }) {
  const db = await getDb();

  /* WHO IS SPEAKING. Fixed Jul 25 2026.

     The user's turns were filed as `user:<mongo id>` and the assistant's as
     'stcky'. Three doors write to this one pool and each invented its own
     vocabulary for the same two people: the front door writes visitor/Eli, the
     Claude surface writes Steven/Eli, and this one wrote user:69daac.../stcky.
     Same pool, same man, three names.

     It cost a real thing today: reading the pool for Steven's own conversation,
     a filter on the obvious labels found nothing and I told him it had not been
     captured. It had. A record nobody can address by name is barely a record --
     the whole promise is that it comes back when you ask for it.

     So the names are the ones a person would use. Computed here, ahead of the
     first write, because the user turn is ingested before anything else. */
  const personaName = user.personaName || (user.tier === 'founder' ? 'Eli' : 'STCKY');
  const userFirstName =
    user.firstName ||
    (user.name ? String(user.name).split(/\s+/)[0] : '') ||
    '';
  const userSpeaker = userFirstName || `user:${user._id}`;

  /* =====================================================================
     A GREETING IS INTERFACE, NOT CONVERSATION. Jul 28 2026.

     Steven, today: "My iPhone keeps stuttering and keeps doing that and keeps
     writing identical entries, responding the same way. I don't know why."

     Between 20:19 and 20:31 his pool took six near-identical greetings --
     "Hey Steven. yoursticky.com is live..." -- each with a slightly different
     tail. The cause: index.html's renderWelcomeBackSignedIn() fires on every
     page open and POSTs a hidden turn beginning "[system: they just opened
     STCKY and are signed in..." to ask their own STCKY to say hello. Good
     idea -- a greeting from something that knows you beats "You're signed in."
     But a phone that reconnects six times sends it six times, and this handler
     ingested every one, both halves.

     THE FRONTEND ALREADY TRIED TO GUARD IT and could not: it compares the new
     hello to the last one and skips exact matches. Ingest tries too, by content
     hash. Both fail for the same reason -- the model writes a genuinely
     different sentence each time. You cannot dedupe your way out of this. The
     text was never the problem.

     THE POOL IS FOR WHAT SOMEBODY SAID. Nobody said this. The machine asked
     itself to say hello because a page loaded. It belongs on the screen and
     nowhere else -- so it is answered fully, with the whole substrate behind
     it, and then not written down. Neither half. The user turn is a stage
     direction, and the reply is a door being held open, not a remark.

     This lives HERE and not in the frontend deliberately. There are three
     doors onto this pool and more coming; a guard in one page protects one
     page. A flaky connection must not be able to write to somebody's substrate
     from ANY client, including ones not written yet.
     ===================================================================== */
  const ephemeral = isEphemeralOpener(message);

  // 1. Ingest user turn first (persists even if downstream fails) --
  //    unless this is the page saying hello to itself.
  if (!ephemeral) {
    await putObject(db, user._id, {
      content: message,
      source_type: 'conversation',
      speaker: userSpeaker,
    });
  }

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

  // 2b. PULL THE STRINGS. Every semantic hit older than the recent window drags
  //     its NEIGHBOURHOOD forward -- the turns around that moment, whole, in
  //     order. Search located it; now we READ the region, because a point without
  //     its neighbours is a citation, and a citation is not a memory.
  const regionObjects = await pullRegions(db, user._id, hybrid, lowerBound);

  const substratePull = formatSubstrateContext(recentObjects, hybrid, regionObjects);

  // 3. Assemble system prompt with persona + capability + substrate
  //    (personaName and userFirstName are computed at the top of this function,
  //     because the user turn is written to the pool before we get here.)

  // Temporal anchor - the persona's "now". Mirrors the read door's now_human
  // so the mouth speaks the same clock the substrate reads from.
  // Prefer the live browser timezone sent with this request; fall back to the
  // stored value, then to a default. The browser's zone is the user's actual
  // reality - handles travel, never-set, and stale stored values.
  const userTz = clientTimeZone || user.timezone || 'UTC';

  // Self-heal the stored timezone from the live browser so the wake read and
  // future turns stay anchored to the same clock the user is actually on.
  if (clientTimeZone && clientTimeZone !== user.timezone) {
    try {
      await db.collection('users').updateOne(
        { _id: user._id },
        { $set: { timezone: clientTimeZone } }
      );
    } catch (e) {
      console.error('[chat] timezone heal failed:', e.message);
    }
  }
  const nowHuman = new Intl.DateTimeFormat('en-US', {
    timeZone: userTz,
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date());

  const systemPrompt = buildSystemPrompt({
    personaName,
    userFirstName,
    substratePull,
    surface: STCKY_SURFACE,
    now: nowHuman,
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

  // 5. Ingest assistant turn -- unless this whole exchange was the page
  //    greeting its own visitor. See the note above: it is shown, not stored.
  if (!ephemeral) {
    await putObject(db, user._id, {
      content: reply,
      source_type: 'conversation',
      speaker: personaName,
    });
  }

  return res.status(200).json({ response: reply, reply, action: null });
}

/* Is this turn the interface talking to itself rather than a person talking?
   The frontend sends its opener as a bracketed stage direction beginning
   "[system:" -- see renderWelcomeBackSignedIn in index.html. Matched narrowly
   and anchored to the start, so a person who happens to write a bracket in a
   real sentence is still heard and still recorded. When in doubt this returns
   false, because the cost of wrongly DROPPING something somebody said is far
   worse than the cost of wrongly keeping a hello. */
function isEphemeralOpener(message) {
  const m = String(message || '').trim();
  return /^\[system:/i.test(m) && m.endsWith(']');
}

// ─── Helpers ────────────────────────────────────────────────────────────
function extractText(completion) {
  return (completion.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

// ─── THE STRING PULLER ───────────────────────────────────────────────────
// Take the semantic hits and drag their NEIGHBOURHOODS forward, whole.
// Overlapping windows merge, so a busy hour loads once instead of five times.
// Anything already inside the recent window is skipped -- it's arriving anyway.
async function pullRegions(db, userId, hybrid, recentLowerBound) {
  const hits = [];
  for (const o of ((hybrid && hybrid.objects) || [])) {
    const t = new Date(o.ingested_at || o.timestamp);
    if (!isNaN(t) && t < recentLowerBound) hits.push(t);
  }
  for (const m of ((hybrid && hybrid.memories) || [])) {
    const t = new Date(m.updatedAt || m.createdAt);
    if (!isNaN(t) && t < recentLowerBound) hits.push(t);
  }
  if (!hits.length) return [];

  const R = REGION_RADIUS_MIN * 60 * 1000;
  const spans = hits
    .map(t => ({ from: new Date(t.getTime() - R), to: new Date(t.getTime() + R) }))
    .sort((a, b) => a.from - b.from);

  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.from <= last.to) {
      if (s.to > last.to) last.to = s.to;
    } else {
      merged.push({ from: s.from, to: s.to });
    }
  }

  try {
    return await db.collection('objects')
      .find({
        userId,
        $or: merged.map(w => ({ ingested_at: { $gte: w.from, $lte: w.to } })),
        'metadata.event_type': { $ne: 'tool_event' },
      })
      .sort({ ingested_at: -1 })
      .limit(REGION_MAX_OBJECTS)
      .toArray();
  } catch (e) {
    console.error('[chat] region pull failed:', e.message);
    return [];   // a failed pull must never take the whole turn down
  }
}

// Merge recent objects + pulled regions + semantic hits into one substrate
// context. Whole bodies, never previews. Dedup by _id.
//
// WHEN THE BUDGET RUNS OUT IT SAYS SO, OUT LOUD. The old version simply stopped
// adding and said nothing -- so the agent could not tell "the pool doesn't have
// it" from "the window filled before it got there," and would then tell the user
// something wasn't there when it was. That is the exact failure the second law
// forbids: a STCKY must never falsely forget. Silence is not evidence. If the
// window is full, the CONTEXT SAYS THE WINDOW IS FULL.
function formatSubstrateContext(recentObjects, hybrid, regionObjects) {
  const recent = Array.isArray(recentObjects) ? recentObjects : [];
  const region = Array.isArray(regionObjects) ? regionObjects : [];
  const assocObjects = (hybrid && Array.isArray(hybrid.objects)) ? hybrid.objects : [];
  const assocMemories = (hybrid && Array.isArray(hybrid.memories)) ? hybrid.memories : [];

  if (!recent.length && !region.length && !assocObjects.length && !assocMemories.length) {
    return '(substrate is empty — be warm, let them shape you.)';
  }

  const seen = new Set();
  const lines = [];
  let chars = 0;
  let dropped = 0;

  const add = (line) => {
    if (chars + line.length > CONTEXT_CHAR_BUDGET) { dropped++; return false; }
    lines.push(line);
    chars += line.length;
    return true;
  };
  const obj = (o) => `[${o.timestamp || o.ingested_at || ''}] ${o.speaker}: ${o.content}`;

  // Section 1: NOW. The default anchor, whole, oldest-first so it reads forward.
  if (recent.length) {
    lines.push('## NOW — recent conversation (last 36h, whole, nothing truncated)');
    for (const o of [...recent].reverse()) {
      const id = String(o._id);
      if (seen.has(id)) continue;
      if (add(obj(o))) seen.add(id);
    }
  }

  // Section 2: THE REGIONS THIS TURN PULLED FORWARD. Not hits — neighbourhoods.
  const regionFresh = region.filter(o => !seen.has(String(o._id)));
  if (regionFresh.length) {
    lines.push('');
    lines.push('## PULLED FORWARD BY THIS TURN — older moments, with the turns around them, whole');
    lines.push('(Something you just said reached back and touched these. They are not "the past" now — they are context, sitting next to now. Read them as such.)');
    for (const o of [...regionFresh].reverse()) {
      const id = String(o._id);
      if (seen.has(id)) continue;
      if (add(obj(o))) seen.add(id);
    }
  }

  // Section 3: any semantic hit whose neighbourhood didn't make it (never drop a hit).
  const assocFresh = assocObjects.filter(o => !seen.has(String(o._id)));
  if (assocFresh.length) {
    lines.push('');
    lines.push('## Also surfaced by this turn');
    for (const o of assocFresh) {
      const id = String(o._id);
      if (add(obj(o))) seen.add(id);
    }
  }

  // Section 4: curated canon.
  if (assocMemories.length) {
    lines.push('');
    lines.push('## Relevant canon');
    for (const m of assocMemories) {
      const id = String(m._id);
      if (seen.has(id)) continue;
      const slug = `${m.category || '?'}/${m.key || '?'}`;
      if (add(`[${m.updatedAt || m.createdAt || ''}] ${slug}: ${m.value || ''}`)) seen.add(id);
    }
  }

  // THE HONEST EDGE. Never a silent cut.
  if (dropped > 0) {
    lines.push('');
    lines.push(`## *** ${dropped} MORE ITEM(S) MATCHED AND DID NOT FIT IN THIS CONTEXT WINDOW ***`);
    lines.push('THE WINDOW FILLED. THE POOL DID NOT RUN OUT. These two things are not the same, and you must never');
    lines.push('report the first as the second. If the user asks about something you cannot see here, the honest');
    lines.push('answer is "my window filled — let me slide the anchor and look again," NOT "I don\'t have that."');
    lines.push('A STCKY never falsely forgets.');
  }

  return lines.join('\n');
}
