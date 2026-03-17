import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import FirecrawlApp from '@mendable/firecrawl-js';

// Disable Vercel's body parser so we can read the raw body for HMAC verification
export const config = {
  api: { bodyParser: false },
};

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

const KAPSO_API_KEY = process.env.KAPSO_API_KEY!;
const KAPSO_PHONE_NUMBER_ID = process.env.KAPSO_PHONE_NUMBER_ID!;
const KAPSO_WEBHOOK_SECRET = process.env.KAPSO_WEBHOOK_SECRET;

// ── Types ──────────────────────────────────────────────────────────────────

interface KapsoMessage {
  id: string;
  message_type: 'text' | 'image' | 'audio' | 'video' | 'document' | 'location' | 'interactive';
  content?: string;
  from: string;
  direction: 'inbound' | 'outbound';
  message_type_data?: { caption?: string; has_media?: boolean };
  media_data?: { url: string; filename?: string; content_type?: string };
}

interface KapsoWebhookPayload {
  message: KapsoMessage;
  conversation: { id: string; phone_number: string };
  is_new_conversation?: boolean;
}

// ── Raw body + signature ───────────────────────────────────────────────────

function getRawBody(req: VercelRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => chunks.push(chunk));
    req.on('end', () => resolve(chunks.join('')));
    req.on('error', reject);
  });
}

function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    const sigBuf = new Uint8Array(Buffer.from(signature, 'utf8'));
    const expBuf = new Uint8Array(Buffer.from(expected, 'utf8'));
    return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

// ── Kapso send ─────────────────────────────────────────────────────────────

async function sendWhatsAppMessage(to: string, text: string): Promise<void> {
  const url = `https://api.kapso.ai/meta/whatsapp/v24.0/${KAPSO_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-API-Key': KAPSO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Kapso send failed (${res.status}): ${body}`);
  }
}

// ── Firecrawl gift search ──────────────────────────────────────────────────

interface GiftResult {
  title: string;
  price?: string;
  url: string;
  description?: string;
}

async function searchGifts(query: string): Promise<GiftResult[]> {
  const results = await firecrawl.search(`buy gift ${query}`, {
    limit: 5,
  });

  const webResults = results.web ?? [];
  return webResults.slice(0, 5).map((r) => ({
    title: (r as { title?: string; url: string; description?: string }).title ?? 'Gift idea',
    url: (r as { url: string }).url,
    description: (r as { description?: string }).description,
  }));
}

// ── Claude gift concierge ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a warm, helpful gift concierge on WhatsApp. Your job is to understand who someone wants to buy a gift for and find the perfect suggestions.

Keep replies concise and conversational — WhatsApp format, not email. Use short paragraphs. Emoji are ok but don't overdo it.

When you have enough info about the recipient (their interests, relationship, occasion, budget), call the search_gifts tool to find real product options. You can call it multiple times with different queries.

After getting search results, present 3–5 gift ideas clearly: name, why it suits them, and a link to buy.

If the user sends an image (Instagram screenshot, wishlist, etc.), acknowledge it and ask who it's for if not clear.`;

async function runGiftConcierge(
  userMessage: string,
  conversationHistory: Anthropic.MessageParam[]
): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    ...conversationHistory,
    { role: 'user', content: userMessage },
  ];

  const tools: Anthropic.Tool[] = [
    {
      name: 'search_gifts',
      description: 'Search the web for gift products matching a query. Call this when you have enough info about the recipient to find relevant gifts.',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Search query e.g. "gifts for hiking enthusiast under $50" or "tech gadgets for teenager"',
          },
        },
        required: ['query'],
      },
    },
  ];

  let response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    thinking: { type: 'adaptive' },
    system: SYSTEM_PROMPT,
    tools,
    messages,
  });

  // Agentic loop — let Claude call search_gifts as many times as it needs
  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    );

    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const tool of toolUseBlocks) {
      if (tool.name === 'search_gifts') {
        const input = tool.input as { query: string };
        let resultContent: string;
        try {
          const gifts = await searchGifts(input.query);
          resultContent = JSON.stringify(gifts);
        } catch (err) {
          resultContent = JSON.stringify({ error: String(err) });
        }
        toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: resultContent });
      }
    }

    messages.push({ role: 'user', content: toolResults });

    response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });
  }

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  return textBlock?.text ?? "Sorry, I couldn't come up with gift ideas right now. Try again in a moment!";
}

// ── Conversation store (in-memory, resets on cold start) ───────────────────
// For production, swap this for Redis or Vercel KV.
const conversationStore = new Map<string, Anthropic.MessageParam[]>();

function getHistory(from: string): Anthropic.MessageParam[] {
  return conversationStore.get(from) ?? [];
}

function appendHistory(from: string, userMsg: string, assistantMsg: string): void {
  const history = getHistory(from);
  history.push({ role: 'user', content: userMsg });
  history.push({ role: 'assistant', content: assistantMsg });
  // Keep last 20 turns to stay within context limits
  const trimmed = history.slice(-20);
  conversationStore.set(from, trimmed);
}

// ── Message handling ───────────────────────────────────────────────────────

async function handleIncomingMessage(payload: KapsoWebhookPayload): Promise<void> {
  const { message, is_new_conversation } = payload;
  const from = message.from;

  // Greet on fresh conversation start
  if (is_new_conversation && !message.content?.trim()) {
    await sendWhatsAppMessage(
      from,
      "👋 Hi! I'm your Gift Concierge.\n\nTell me who you're shopping for — their interests, the occasion, and your budget — and I'll find the perfect gift ideas!"
    );
    return;
  }

  let userText: string;

  if (message.message_type === 'image') {
    const caption = message.message_type_data?.caption;
    userText = caption
      ? `[User sent an image with caption: "${caption}"]`
      : '[User sent an image — likely a photo of the recipient or their interests]';
  } else if (message.message_type === 'text' && message.content) {
    userText = message.content;
  } else {
    return; // Ignore unsupported message types
  }

  const history = getHistory(from);
  const reply = await runGiftConcierge(userText, history);

  appendHistory(from, userText, reply);
  await sendWhatsAppMessage(from, reply);
}

// ── Main handler ───────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = await getRawBody(req);
  const signature = req.headers['x-webhook-signature'] as string | undefined;

  if (KAPSO_WEBHOOK_SECRET) {
    if (!signature || !verifySignature(rawBody, signature, KAPSO_WEBHOOK_SECRET)) {
      console.error('Webhook signature verification failed');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const event = req.headers['x-webhook-event'] as string | undefined;

  if (event !== 'whatsapp.message.received') {
    return res.status(200).json({ ok: true });
  }

  const payload = JSON.parse(rawBody) as KapsoWebhookPayload;

  if (payload.message?.direction === 'outbound') {
    return res.status(200).json({ ok: true });
  }

  // Acknowledge Kapso immediately (required within 10s)
  res.status(200).json({ ok: true });

  try {
    await handleIncomingMessage(payload);
  } catch (err) {
    console.error('Error handling message:', err);
  }
}
