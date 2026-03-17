import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';

// Disable Vercel's body parser so we can read the raw body for HMAC verification
export const config = {
  api: { bodyParser: false },
};

const KAPSO_API_KEY = process.env.KAPSO_API_KEY!;
const KAPSO_PHONE_NUMBER_ID = process.env.KAPSO_PHONE_NUMBER_ID!;
const KAPSO_WEBHOOK_SECRET = process.env.KAPSO_WEBHOOK_SECRET;

// ── Types ──────────────────────────────────────────────────────────────────

interface KapsoMessage {
  id: string;
  message_type: 'text' | 'image' | 'audio' | 'video' | 'document' | 'location' | 'interactive';
  content?: string; // text body
  from: string;     // sender phone number e.g. "+15551234567"
  direction: 'inbound' | 'outbound';
  message_type_data?: {
    caption?: string;
    has_media?: boolean;
  };
  media_data?: {
    url: string;
    filename?: string;
    content_type?: string;
  };
}

interface KapsoWebhookPayload {
  message: KapsoMessage;
  conversation: {
    id: string;
    phone_number: string;
  };
  is_new_conversation?: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifySignature(rawBody: Buffer, signature: string, secret: string): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function sendWhatsAppMessage(to: string, text: string): Promise<void> {
  const url = `https://api.kapso.ai/meta/whatsapp/v24.0/${KAPSO_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-API-Key': KAPSO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Kapso send failed (${res.status}): ${body}`);
  }
}

// ── Message handling ───────────────────────────────────────────────────────

async function handleIncomingMessage(payload: KapsoWebhookPayload): Promise<void> {
  const { message, is_new_conversation } = payload;
  const from = message.from;

  // New conversation — send greeting
  if (is_new_conversation || !message.content?.trim()) {
    await sendWhatsAppMessage(
      from,
      "👋 Hi! I'm your Gift Concierge.\n\nWho would you like to find a gift for? Tell me about them — their name, interests, hobbies, or even share a screenshot of their Instagram!"
    );
    return;
  }

  if (message.message_type === 'image') {
    const caption = message.message_type_data?.caption;
    await sendWhatsAppMessage(
      from,
      `📸 Got your image${caption ? ` with caption: "${caption}"` : ''}!\n\nI'll use this to understand their style and interests. Who is this gift for?`
    );
    return;
  }

  if (message.message_type === 'text' && message.content) {
    // Placeholder — Claude + Firecrawl integration comes next
    await sendWhatsAppMessage(
      from,
      `Got it! 🎁 I'm working on finding the perfect gift options for you.\n\n(Full gift search powered by Claude + Firecrawl coming very soon!)`
    );
  }
}

// ── Main handler ───────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = await getRawBody(req);
  const signature = req.headers['x-webhook-signature'] as string | undefined;

  // Verify HMAC signature if a secret is configured
  if (KAPSO_WEBHOOK_SECRET) {
    if (!signature || !verifySignature(rawBody, signature, KAPSO_WEBHOOK_SECRET)) {
      console.error('Webhook signature verification failed');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const event = req.headers['x-webhook-event'] as string | undefined;

  // Acknowledge non-message events immediately
  if (event !== 'whatsapp.message.received') {
    return res.status(200).json({ ok: true });
  }

  const payload = JSON.parse(rawBody.toString('utf8')) as KapsoWebhookPayload;

  // Ignore outbound echoes
  if (payload.message?.direction === 'outbound') {
    return res.status(200).json({ ok: true });
  }

  // Respond to Kapso immediately (required within 10s)
  res.status(200).json({ ok: true });

  // Process and reply
  try {
    await handleIncomingMessage(payload);
  } catch (err) {
    console.error('Error handling message:', err);
  }
}
