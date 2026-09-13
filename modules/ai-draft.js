/**
 * MailguyAI — AI-drafted reply generation.
 *
 * The venture's own spec (ventures.json) calls this an "intelligent email
 * management system" that understands and responds to messages - the one
 * piece missing before this file: everything shipped so far (the landing
 * page's rule-based triage scorer, the sovereign send/receive gateway,
 * AuthFor multi-user access) is real, but none of it actually reads a
 * message and drafts a reply. This wires the same real, already-proven
 * local-LLM bridge that mobley-venture-fleet-a's /api/story-treatment uses
 * (llama.mobleysoft.com, a Cloudflare Access-gated front for the local
 * Qwen3-8B inference server) instead of adding a new external AI API
 * dependency - per AGENTS.md/CLAUDE.md's "build capability-first" rule.
 *
 * Human-in-the-loop by design, matching this venture's own spec_draft
 * ("review-and-send rather than full autopilot" - its research_note
 * flags real liability in an autopilot that sends something wrong). This
 * only ever returns a draft for a human to review and send via the
 * existing me-routes.js send path; it never sends anything itself.
 */

const JITAGI_URL = 'https://llama.mobleysoft.com/v1/chat/completions';

const SYSTEM_PROMPT = `You are an email assistant drafting a reply on behalf of the mailbox owner. Read the original message and write a short, professional draft reply. Output ONLY the reply body text - no subject line, no explanation, no markdown formatting. If the message is spam, a newsletter, or doesn't warrant a reply, output exactly: NO_REPLY_NEEDED.`;

/** Crude-but-real plain-text extraction from a raw MIME message: drops header/boundary lines rather than parsing full MIME - good enough for an LLM prompt, not meant as a general MIME parser. */
function extractPlainText(raw) {
  return raw
    .split(/\r?\n/)
    .filter((line) => !/^(--|Content-Type:|Content-Transfer-Encoding:|MIME-Version:|From:|To:|Subject:|Date:)/i.test(line))
    .join('\n')
    .trim()
    .slice(0, 4000);
}

/**
 * Draft a reply to a stored message using the shared local-LLM bridge.
 * Returns { draft: string|null, needsReply: boolean } - draft is null and
 * needsReply is false when the model judges no reply is warranted.
 * Throws if the bridge isn't configured (missing Access service-token
 * secrets) or the call fails - callers should surface that as a real
 * error, never fall back to a fake draft.
 */
export async function draftReply(env, message) {
  if (!env.LLAMA_ACCESS_CLIENT_ID || !env.LLAMA_ACCESS_CLIENT_SECRET) {
    throw new Error('AI draft-reply is not configured: LLAMA_ACCESS_CLIENT_ID/SECRET missing on this Worker');
  }

  const body = message.raw ? extractPlainText(message.raw) : (message.subject || '');
  const userMessage = `From: ${message.from_addr}\nSubject: ${message.subject || '(no subject)'}\n\n${body}`;

  const res = await fetch(JITAGI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Access-Client-Id': env.LLAMA_ACCESS_CLIENT_ID,
      'CF-Access-Client-Secret': env.LLAMA_ACCESS_CLIENT_SECRET,
    },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 400,
      temperature: 0.4,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `AI draft bridge HTTP ${res.status}`);
  }

  const content = (data.choices?.[0]?.message?.content ?? '').trim();
  if (!content || content === 'NO_REPLY_NEEDED') {
    return { draft: null, needsReply: false };
  }
  return { draft: content, needsReply: true };
}
