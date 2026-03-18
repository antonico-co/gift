import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import FirecrawlApp from '@mendable/firecrawl-js';
import { kv } from '@vercel/kv';

// Disable Vercel's body parser so we can read the raw body for HMAC verification
export const config = {
  api: { bodyParser: false },
};

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

const KAPSO_API_KEY = process.env.KAPSO_API_KEY!;
const KAPSO_PHONE_NUMBER_ID = process.env.KAPSO_PHONE_NUMBER_ID!;
const KAPSO_WEBHOOK_SECRET = process.env.KAPSO_WEBHOOK_SECRET;

if (!KAPSO_WEBHOOK_SECRET) {
  console.warn('Warning: KAPSO_WEBHOOK_SECRET is not set — incoming webhook requests will not be authenticated.');
}

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

// ── Payload validation ─────────────────────────────────────────────────────

export function validatePayload(payload: unknown): payload is KapsoWebhookPayload {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  const msg = p.message;
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  if (typeof m.id !== 'string' || typeof m.from !== 'string') return false;
  if (typeof m.message_type !== 'string') return false;
  const conv = p.conversation;
  if (!conv || typeof conv !== 'object') return false;
  const c = conv as Record<string, unknown>;
  if (typeof c.id !== 'string' || typeof c.phone_number !== 'string') return false;
  return true;
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

export function verifySignature(rawBody: string, signature: string, secret: string): boolean {
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

// ── Image fetching ─────────────────────────────────────────────────────────

async function fetchImageAsBase64(url: string): Promise<{ data: string; mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' }> {
  const res = await fetch(url, {
    headers: { 'X-API-Key': KAPSO_API_KEY },
  });
  if (!res.ok) throw new Error(`Failed to fetch image (${res.status})`);

  const contentType = res.headers.get('content-type') ?? 'image/jpeg';
  const mediaType = (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(contentType)
    ? contentType
    : 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

  const buffer = await res.arrayBuffer();
  const data = Buffer.from(buffer).toString('base64');
  return { data, mediaType };
}

// ── Firecrawl gift search ──────────────────────────────────────────────────

interface GiftResult {
  title: string;
  url: string;
  description?: string;
  price?: string;
}

export const PRICE_RE = /(?:£|€|\$|US\$|CA\$|AU\$|NZ\$)\s?[\d,]+(?:\.\d{1,2})?|(?:USD|GBP|EUR|CAD|AUD)\s?[\d,]+(?:\.\d{1,2})?|[\d,]+(?:\.\d{1,2})?\s?(?:USD|GBP|EUR)/i;

async function searchGifts(query: string): Promise<GiftResult[]> {
  const results = await firecrawl.search(`${query}`, {
    limit: 5,
    scrapeOptions: { formats: ['markdown'] },
  });

  const webResults = results.web ?? [];
  return webResults.slice(0, 5).map((r) => {
    const item = r as { title?: string; url: string; description?: string; markdown?: string };
    // Try to pull a price from the scraped page markdown
    const priceMatch = item.markdown?.match(PRICE_RE);
    return {
      title: item.title ?? 'Gift idea',
      url: item.url,
      description: item.description,
      price: priceMatch?.[0],
    };
  });
}

// ── Claude gift concierge ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a warm, helpful gift concierge on WhatsApp. Your job is to understand who someone wants to buy a gift for and find the perfect suggestions.

Keep replies concise and conversational — WhatsApp format, not email. Use short paragraphs. Emoji are ok but don't overdo it.

When you have enough info about the recipient (their interests, relationship, occasion, budget), call the search_gifts tool to find real product options. You can call it multiple times with different queries.

For the search query, target real shopping sites to get better results — for example:
- "etsy personalised gift for dog lover"
- "amazon gifts for home baker under £40"
- "notonthehighstreet unique birthday gift for mum"
- "uncommongoods gifts for coffee enthusiast"

After getting search results, present 3–5 gift ideas clearly: name, price (if shown), why it suits the recipient, and a link to buy. If no price was found, say "check site for price."

If the user sends an image, analyse it carefully — it could be an Instagram profile, a wishlist, a photo of the person, or something they like. Extract any useful clues about their interests, age, style, or hobbies, and use those to inform your gift search.`;

type UserContent = string | Anthropic.MessageParam['content'];

async function runGiftConcierge(
  userContent: UserContent,
  conversationHistory: Anthropic.MessageParam[]
): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    ...conversationHistory,
    { role: 'user', content: userContent as Anthropic.MessageParam['content'] },
  ];

  const tools: Anthropic.Tool[] = [
    {
      name: 'search_gifts',
      description: 'Search the web for gift products. Target shopping sites for better results e.g. "etsy personalised gift dog lover" or "amazon tech gadgets teenager under £50".',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Search query targeting a shopping site e.g. "etsy gifts for plant lover" or "amazon hiking gifts under $50"',
          },
        },
        required: ['query'],
      },
    },
  ];

  let response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2048,
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
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });
  }

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  return textBlock?.text ?? "Sorry, I couldn't come up with gift ideas right now. Try again in a moment!";
}

// ── Conversation store (Vercel KV) ─────────────────────────────────────────

const KV_TTL_SECONDS = 60 * 60 * 24; // 24 hours — expires after a day of inactivity

async function getHistory(from: string): Promise<Anthropic.MessageParam[]> {
  return (await kv.get<Anthropic.MessageParam[]>(`chat:${from}`)) ?? [];
}

async function clearHistory(from: string): Promise<void> {
  await kv.del(`chat:${from}`);
}

// Replace image blocks with a lightweight placeholder before storing in KV.
// Keeps history small and avoids re-sending large base64 blobs to Claude.
export function toStorableContent(content: UserContent): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      const b = block as { type: string; text?: string };
      if (b.type === 'image') return '[image]';
      return b.text ?? '';
    }).filter(Boolean).join(' ');
  }
  return '[message]';
}

async function appendHistory(from: string, userContent: UserContent, assistantMsg: string): Promise<void> {
  const history = await getHistory(from);
  history.push({ role: 'user', content: toStorableContent(userContent) });
  history.push({ role: 'assistant', content: assistantMsg });
  await kv.set(`chat:${from}`, history.slice(-20), { ex: KV_TTL_SECONDS });
}

// ── Message handling ───────────────────────────────────────────────────────

export const RESET_TRIGGERS = /\b(reset|start over|new gift|restart|clear|begin again)\b/i;

const GREETING =
  "👋 Hi! I'm your Gift Concierge.\n\nTell me who you're shopping for — their interests, the occasion, and your budget — and I'll find the perfect gift ideas!";

async function handleIncomingMessage(payload: KapsoWebhookPayload): Promise<void> {
  const { message, is_new_conversation } = payload;
  const from = message.from;

  // Greet on fresh conversation start (no message body yet)
  if (is_new_conversation && !message.content?.trim()) {
    await sendWhatsAppMessage(from, GREETING);
    return;
  }

  // Reset trigger — wipe history and re-greet
  if (message.message_type === 'text' && RESET_TRIGGERS.test(message.content ?? '')) {
    await clearHistory(from);
    await sendWhatsAppMessage(from, "🔄 Starting fresh!\n\n" + GREETING);
    return;
  }

  let userContent: UserContent;

  if (message.message_type === 'image' && message.media_data?.url) {
    // Fetch the real image and pass it to Claude Vision
    const caption = message.message_type_data?.caption;
    try {
      const { data, mediaType } = await fetchImageAsBase64(message.media_data.url);
      userContent = [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data } } satisfies Anthropic.ImageBlockParam,
        { type: 'text', text: caption ? `Caption: "${caption}"` : 'What can you tell about this person or their interests from this image?' } satisfies Anthropic.TextBlockParam,
      ];
    } catch {
      // Fall back to text description if image fetch fails
      userContent = caption
        ? `[User sent an image with caption: "${caption}"]`
        : '[User sent an image — likely a photo of the recipient or their interests]';
    }
  } else if (message.message_type === 'text' && message.content) {
    userContent = message.content;
  } else {
    return; // Ignore unsupported message types
  }

  const history = await getHistory(from);
  const reply = await runGiftConcierge(userContent, history);

  await appendHistory(from, userContent, reply);
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

  const parsed: unknown = JSON.parse(rawBody);
  if (!validatePayload(parsed)) {
    console.error('Invalid webhook payload structure:', rawBody.slice(0, 200));
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const payload = parsed;

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
