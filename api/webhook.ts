import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";
import FirecrawlApp from "@mendable/firecrawl-js";
import { kv } from "@vercel/kv";
import { get } from "@vercel/edge-config";
import { createHmac, timingSafeEqual } from "crypto";

// Vercel doesn't always parse the body — read the raw stream instead
function readRawBody(req: VercelRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export const config = {
  api: { bodyParser: false },
};

// Lazy accessors so env vars are read at request time (testable, and safe for serverless)
const getAnthropic = () => new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const getFirecrawl = () => new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });
const kapsoApiKey = () => process.env.KAPSO_API_KEY!;
const kapsoPhoneNumberId = () => process.env.KAPSO_PHONE_NUMBER_ID!;
const kapsoWebhookSecret = () => process.env.KAPSO_WEBHOOK_SECRET!;

const HISTORY_TTL = 60 * 60 * 6; // 6h — resets after inactivity
const INACTIVITY_RESET = 60 * 60 * 4; // 4h — start fresh if idle this long
const MAX_HISTORY = 20;

// --- Types ---

interface KapsoTextMessage {
  type: "text";
  from: string;
  id: string;
  text: { body: string };
  kapso: { direction: "inbound" | "outbound" };
}

interface KapsoImageMessage {
  type: "image";
  from: string;
  id: string;
  image: { id: string; mime_type: string };
  kapso: {
    direction: "inbound" | "outbound";
    media_url?: string;
    media_data?: { url: string; filename: string; content_type: string; byte_size: number };
  };
}

type KapsoMessage = KapsoTextMessage | KapsoImageMessage;

interface KapsoWebhookPayload {
  type: string;
  batch: boolean;
  data: Array<{ message: KapsoMessage; conversation: { id: string } }>;
}

// --- Signature verification ---

function verifySignature(req: VercelRequest, body: string): boolean {
  const sig = req.headers["x-webhook-signature"];
  if (!sig || typeof sig !== "string") return false;
  const expected = createHmac("sha256", kapsoWebhookSecret())
    .update(body)
    .digest("hex");
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// --- Conversation history ---

type ConversationMessage = Anthropic.MessageParam;

interface StoredHistory {
  messages: ConversationMessage[];
  lastMessageAt: number; // unix timestamp in seconds
}

async function getHistory(phone: string): Promise<ConversationMessage[]> {
  const stored = await kv.get<StoredHistory>(`chat:${phone}`);
  if (!stored) return [];
  const idleSeconds = Math.floor(Date.now() / 1000) - stored.lastMessageAt;
  if (idleSeconds > INACTIVITY_RESET) return []; // stale — start fresh
  return stored.messages;
}

async function saveHistory(
  phone: string,
  history: ConversationMessage[]
): Promise<void> {
  const trimmed = history.slice(-MAX_HISTORY);
  const stored: StoredHistory = {
    messages: trimmed,
    lastMessageAt: Math.floor(Date.now() / 1000),
  };
  await kv.set(`chat:${phone}`, stored, { ex: HISTORY_TTL });
}

// --- Kapso API ---

async function sendWhatsAppMessage(to: string, text: string): Promise<void> {
  const url = `https://api.kapso.ai/meta/whatsapp/v24.0/${kapsoPhoneNumberId()}/messages`;
  const body = JSON.stringify({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  });
  console.log("Sending to Kapso:", url, body.slice(0, 200));
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": kapsoApiKey(),
    },
    body,
  });
  const resText = await res.text();
  console.log("Kapso send response:", res.status, resText.slice(0, 300));
}

async function fetchImageAsBase64(
  mediaUrl: string,
  contentType: string
): Promise<{ data: string; mediaType: string }> {
  console.log("Fetching media URL:", mediaUrl);
  const imgRes = await fetch(mediaUrl, {
    headers: { "X-API-Key": kapsoApiKey() },
  });
  console.log("Media fetch status:", imgRes.status);
  const buffer = await imgRes.arrayBuffer();
  return {
    data: Buffer.from(buffer).toString("base64"),
    mediaType: contentType,
  };
}

// --- Restaurant search tool ---

async function searchRestaurants(query: string): Promise<string> {
  const result = await getFirecrawl().search(query, { limit: 5 });
  const items = result.web ?? [];
  if (!items.length) return "No results found.";
  return items
    .map((r) => {
      const url = "url" in r ? r.url : "";
      const title = "title" in r ? r.title : "";
      const description = "description" in r ? r.description : "";
      return `**${title ?? ""}**\n${description ?? ""}\n${url}`;
    })
    .join("\n\n");
}

const tools: Anthropic.Tool[] = [
  {
    name: "search_restaurants",
    description:
      "Search the web for restaurant recommendations. Prefer results with OpenTable reservation links. Use this to find real restaurants matching the user's cuisine, vibe, location, and occasion.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Search query, e.g. 'best romantic Italian restaurants in Manhattan with OpenTable reservations'",
        },
      },
      required: ["query"],
    },
  },
];

const DEFAULT_SYSTEM_PROMPT = `You are a warm, knowledgeable restaurant concierge on WhatsApp. Your job is to help people find the perfect restaurant for any occasion.

Ask friendly questions to understand:
- What city or neighborhood they're in
- The occasion (date night, business lunch, family dinner, casual catch-up, etc.)
- Cuisine preferences or cravings
- Vibe (cozy, lively, fine dining, outdoor, etc.)
- Group size and budget

**When the user sends an image:**
If it looks like an Instagram profile or social media screenshot, analyze it carefully for dining signals:
- Food or restaurant photos they've posted or liked
- Cuisine styles and aesthetic preferences (rustic, modern, street food, upscale, etc.)
- Lifestyle clues (adventurous eater, health-conscious, wine lover, etc.)
- Locations or neighborhoods they frequent

Summarize what you learned in 1–2 sentences, then immediately use the search_restaurants tool to find tailored restaurant recommendations. Don't ask follow-up questions if the image gives you enough to work with — just search and suggest.

Once you have enough context (from conversation or an image), use the search_restaurants tool to find real restaurants. Present 3–5 curated suggestions with name, cuisine, vibe, and a link — prioritize results with OpenTable reservation links when available. Keep replies concise and conversational — this is WhatsApp, not a review site.`;

async function getSystemPrompt(): Promise<string> {
  try {
    const prompt = await get<string>("system_prompt");
    return prompt ?? DEFAULT_SYSTEM_PROMPT;
  } catch {
    return DEFAULT_SYSTEM_PROMPT;
  }
}

// --- Agentic Claude loop ---

async function getClaudeReply(
  history: ConversationMessage[]
): Promise<string> {
  const messages = [...history];
  const systemPrompt = await getSystemPrompt();

  while (true) {
    const response = await getAnthropic().messages.create({
      model: "claude-opus-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      tools,
      messages,
    });

    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find((b) => b.type === "text");
      return textBlock ? textBlock.text : "Sorry, I couldn't generate a reply.";
    }

    if (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use" && block.name === "search_restaurants") {
          const input = block.input as { query: string };
          const result = await searchRestaurants(input.query);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    break;
  }

  return "Sorry, something went wrong. Please try again.";
}

// --- Main handler ---

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const rawBody = await readRawBody(req);
  const event = req.headers["x-webhook-event"];

  if (event !== "whatsapp.message.received") {
    res.status(200).json({ ok: true });
    return;
  }

  if (!verifySignature(req, rawBody)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const payload: KapsoWebhookPayload = JSON.parse(rawBody);

  const inbound = payload.data?.filter(
    (d) => d.message.kapso.direction === "inbound"
  );

  if (!inbound?.length) {
    res.status(200).json({ ok: true });
    return;
  }

  const msg = inbound[0].message;
  const phone = msg.from.startsWith("+") ? msg.from : `+${msg.from}`;

  try {
    const history = await getHistory(phone);
    let userContent: Anthropic.MessageParam["content"];

    if (msg.type === "image") {
      const mediaUrl = msg.kapso.media_url ?? msg.kapso.media_data?.url;
      if (!mediaUrl) throw new Error("No media_url in Kapso payload");
      const contentType = msg.kapso.media_data?.content_type ?? "image/jpeg";
      const { data, mediaType } = await fetchImageAsBase64(mediaUrl, contentType);
      userContent = [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType as
              | "image/jpeg"
              | "image/png"
              | "image/gif"
              | "image/webp",
            data,
          },
        },
        { type: "text", text: "The user sent this image. It may be an Instagram profile or social media screenshot — analyze it for dining preferences, cuisine interests, lifestyle, and vibe to suggest the perfect restaurants." },
      ];
    } else {
      userContent = msg.text.body;
    }

    const updatedHistory: ConversationMessage[] = [
      ...history,
      { role: "user", content: userContent },
    ];

    const reply = await getClaudeReply(updatedHistory);

    updatedHistory.push({ role: "assistant", content: reply });
    await saveHistory(phone, updatedHistory);

    await sendWhatsAppMessage(phone, reply);
  } catch (err) {
    console.error("Webhook error:", err);
  }

  res.status(200).json({ ok: true });
}
