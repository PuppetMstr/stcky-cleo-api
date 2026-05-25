// chat.js
//
// POST /api/chat — substrate-aware chat surface for stcky.ai users.
//
// Frontend contract (existing stcky.ai homepage):
//   Body:    { turns: [{ role: 'user'|'sticky', text: string }, ...] }
//   Returns: { reply: string, action: 'save_form'|null }
//
// Modes (branched on identity.tier):
//   - paid + founder:  substrate mode — ingest user turn, retrieve recency,
//                      call Anthropic with web_search tool, ingest assistant turn
//   - basic + anon:    stateless — frontend-provided turns are the only history,
//                      no server-side persistence

const Anthropic = require('@anthropic-ai/sdk');
const { getDb, auth, cors } = require('./_lib/auth');
const { putObject } = require('./_lib/objects');
const { buildSystemPrompt, STCKY_SURFACE } = require('./_lib/system-prompt');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL                 = 'claude-sonnet-4-5';
const MAX_TOKENS            = 4096;
const SUBSTRATE_RECENCY_MAX = 50;
const CONTEXT_CHAR_BUDGET   = 16000;
const MAX_TOOL_TURNS        = 8;

const SUBSTRATE_TOOLS = [
  { type: 'web_search_20250305', name: 'web_search' },
];

const SAVE_FORM_PROMPT_AFTER_TURNS = 6; // heuristic: suggest save after N substantive user turns

const SYSTEM_PROMPT = `You are this user's STCKY - their substrate-shaped assistant.

STCKY is a continuous pool of every turn the two of you have shared, ingested raw. You read the substrate to be more yourself with them, and every turn here flows back into it. The substrate is the engine; you are a surface.

If a SUBSTRATE section is provided below, treat it as your memory of them - see by reading, not finding. If absent, you're new to each other; be warm and curious, let them shape you. Do not invent specifics about their life that aren't in the substrate or in this conversation.

When you have web_search available, use it when the user's request needs information that isn't in their substrate - like contact info, regulations, current events, or specific facts. Combine substrate knowledge of who they are with live information about the world.`;

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const turns = Array.isArray(body.turns) ? body.turns : null;
    // Back-compat: also accept { message, history } shape
    const directMessage = typeof body.message === 'string' ? body.message : null;
    const directHistory = Array.isArray(body.history) ? body.history : [];

    let userMessage = null;
    let priorMessages = [];

    if (turns && turns.length > 0) {
      const last = turns[turns.length - 1];
      if (!last || last.role !== 'user' || typeof last.text !== 'string') {
        return res.status(400).json({ error: 'last turn must be from user with text' });
      }
      userMessage = last.text;
      priorMessages = turns.slice(0, -1).map(t => ({
        role: t.role === 'sticky' || t.role === 'assistant' ? 'assistant' : 'user',
        content: typeof t.text === 'string' ? t.text : (typeof t.content === 'string' ? t.content : ''),
      })).filter(m => m.content.trim().length > 0);
    } else if (directMessage) {
      userMessage = directMessage;
      priorMessages = directHistory;
    } else {
      return res.status(400).json({ error: 'turns or message required' });
    }

    if (!userMessage || userMessage.trim().length === 0) {
      return res.status(400).json({ error: 'empty user message' });
    }

    const user = await auth(req);
    const isPaid = user && ['paid', 'founder'].includes(user.tier);

    if (isPaid) {
      const reply = await handleSubstrateMode({ user, message: userMessage });
      return res.status(200).json({ reply, action: null });
    }

    const reply = await handleStatelessMode({ message: userMessage, priorMessages });

    // Heuristic save-form prompt: if visitor has spoken enough but isn't signed in
    // (no Bearer token / no user), suggest the inline save form to claim.
    const userTurnCount = turns ? turns.filter(t => t.role === 'user').length : 1;
    const action = (!user && userTurnCount >= SAVE_FORM_PROMPT_AFTER_TURNS) ? 'save_form' : null;

    return res.status(200).json({ reply, action });
  } catch (err) {
    console.error('[chat] error:', err.name, err.message);
    return res.status(500).json({ error: 'internal_error', detail: err.message });
  }
};

async function handleStatelessMode({ message, priorMessages }) {
  const messages = [
    ...priorMessages,
    { role: 'user', content: message },
  ];
  const completion = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages,
  });
  return extractText(completion);
}

async function handleSubstrateMode({ user, message }) {
  const db = await getDb();

  await putObject(db, user._id, {
    content: message,
    source_type: 'conversation',
    speaker: `user:${user._id}`,
  });

  const recentDesc = await db.collection('objects').find({
    userId: user._id,
  })
  .sort({ ingested_at: -1 })
  .limit(SUBSTRATE_RECENCY_MAX)
  .toArray();

  console.log(`[chat] substrate recency: ${recentDesc.length} objects for user ${user._id} (tier=${user.tier})`);

  const recent = recentDesc.reverse();
  const substrateContext = formatSubstrateContext(recent);

  const systemWithSubstrate = buildSystemPrompt({
    surface: STCKY_SURFACE,
    personaName: (user && user.persona_name) ? String(user.persona_name)
      : (user && user.api_key === 'cleo_eb2eaecd66f004eb0d25361675c5d637') ? 'Eli'
      : null,
    userFirstName: (user && user.name) ? String(user.name).split(/s+/)[0] : 'friend',
    substratePull: substrateContext,
  });

  let messages = [{ role: 'user', content: message }];
  let finalResponse = null;

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const completion = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemWithSubstrate,
      messages,
      tools: SUBSTRATE_TOOLS,
    });

    if (completion.stop_reason === 'end_turn' || completion.stop_reason === 'stop_sequence') {
      finalResponse = completion;
      break;
    }
    if (completion.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: completion.content });
      continue;
    }
    finalResponse = completion;
    break;
  }

  if (!finalResponse) throw new Error('tool_use_loop_exceeded_max_turns');

  const responseText = extractText(finalResponse);

  await putObject(db, user._id, {
    content: responseText,
    source_type: 'conversation',
    speaker: 'stcky',
  });

  return responseText;
}

function extractText(completion) {
  return (completion.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

function formatSubstrateContext(recent) {
  if (!recent || recent.length === 0) {
    return '(substrate is empty - be warm, let them shape you.)';
  }
  const lines = ['## Recent conversation'];
  let chars = 0;
  for (const obj of recent) {
    const ts = obj.ingested_at
      ? (typeof obj.ingested_at === 'string' ? obj.ingested_at : new Date(obj.ingested_at).toISOString())
      : (obj.timestamp || '?');
    const speaker = obj.speaker || 'unknown';
    const content = obj.content || '';
    const line = `[${ts}] ${speaker}: ${content}`;
    if (chars + line.length > CONTEXT_CHAR_BUDGET) break;
    lines.push(line);
    chars += line.length;
  }
  return lines.join('\n');
}
