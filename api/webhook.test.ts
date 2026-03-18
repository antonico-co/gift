import { describe, it, expect, vi, beforeAll } from 'vitest';
import crypto from 'crypto';

// Mock external dependencies so the module can be imported without env vars
vi.mock('@vercel/kv', () => ({ kv: { get: vi.fn(), set: vi.fn(), del: vi.fn() } }));
vi.mock('@mendable/firecrawl-js', () => ({ default: class { search = vi.fn(); } }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));

let verifySignature: typeof import('./webhook').verifySignature;
let toStorableContent: typeof import('./webhook').toStorableContent;
let validatePayload: typeof import('./webhook').validatePayload;
let PRICE_RE: typeof import('./webhook').PRICE_RE;
let RESET_TRIGGERS: typeof import('./webhook').RESET_TRIGGERS;

beforeAll(async () => {
  const mod = await import('./webhook');
  verifySignature = mod.verifySignature;
  toStorableContent = mod.toStorableContent;
  validatePayload = mod.validatePayload;
  PRICE_RE = mod.PRICE_RE;
  RESET_TRIGGERS = mod.RESET_TRIGGERS;
});

// ── verifySignature ────────────────────────────────────────────────────────

describe('verifySignature', () => {
  const secret = 'test-secret';
  const body = '{"hello":"world"}';

  function makeHmac(b: string, s: string) {
    return crypto.createHmac('sha256', s).update(b).digest('hex');
  }

  it('returns true for a valid signature', () => {
    const sig = makeHmac(body, secret);
    expect(verifySignature(body, sig, secret)).toBe(true);
  });

  it('returns false for a wrong signature', () => {
    expect(verifySignature(body, 'deadbeef', secret)).toBe(false);
  });

  it('returns false when signature length differs', () => {
    const sig = makeHmac(body, secret).slice(0, 10);
    expect(verifySignature(body, sig, secret)).toBe(false);
  });

  it('returns false when body differs', () => {
    const sig = makeHmac('other body', secret);
    expect(verifySignature(body, sig, secret)).toBe(false);
  });
});

// ── toStorableContent ──────────────────────────────────────────────────────

describe('toStorableContent', () => {
  it('passes strings through unchanged', () => {
    expect(toStorableContent('hello world')).toBe('hello world');
  });

  it('extracts text from text blocks', () => {
    const content = [{ type: 'text', text: 'find a gift for my mum' }];
    expect(toStorableContent(content as never)).toBe('find a gift for my mum');
  });

  it('replaces image blocks with [image]', () => {
    const content = [{ type: 'image' }, { type: 'text', text: 'caption here' }];
    expect(toStorableContent(content as never)).toBe('[image] caption here');
  });

  it('handles content with only images', () => {
    const content = [{ type: 'image' }];
    expect(toStorableContent(content as never)).toBe('[image]');
  });
});

// ── validatePayload ────────────────────────────────────────────────────────

describe('validatePayload', () => {
  const valid = {
    message: { id: 'msg1', from: '+447700900000', message_type: 'text', direction: 'inbound' },
    conversation: { id: 'conv1', phone_number: '+447700900000' },
  };

  it('accepts a well-formed payload', () => {
    expect(validatePayload(valid)).toBe(true);
  });

  it('rejects null', () => {
    expect(validatePayload(null)).toBe(false);
  });

  it('rejects missing message', () => {
    expect(validatePayload({ conversation: valid.conversation })).toBe(false);
  });

  it('rejects missing conversation', () => {
    expect(validatePayload({ message: valid.message })).toBe(false);
  });

  it('rejects message without id', () => {
    const p = { ...valid, message: { ...valid.message, id: undefined } };
    expect(validatePayload(p)).toBe(false);
  });

  it('rejects message without from', () => {
    const p = { ...valid, message: { ...valid.message, from: undefined } };
    expect(validatePayload(p)).toBe(false);
  });

  it('rejects conversation without phone_number', () => {
    const p = { ...valid, conversation: { id: 'x' } };
    expect(validatePayload(p)).toBe(false);
  });
});

// ── PRICE_RE ───────────────────────────────────────────────────────────────

describe('PRICE_RE', () => {
  const matches = [
    '£29.99', '£ 29.99', '£1,299.00',
    '€49', '€ 49.50',
    '$19.99', '$1,500',
    'US$29.99', 'CA$15', 'AU$25.00',
    'USD 29.99', 'GBP 14.99', 'EUR 39',
    '29.99 USD', '14.99 GBP', '39.00 EUR',
  ];

  const nonMatches = [
    'no price here', '123 items', 'about 50 people',
  ];

  matches.forEach((str) => {
    it(`matches "${str}"`, () => {
      expect(PRICE_RE.test(str)).toBe(true);
    });
  });

  nonMatches.forEach((str) => {
    it(`does not match "${str}"`, () => {
      expect(PRICE_RE.test(str)).toBe(false);
    });
  });
});

// ── RESET_TRIGGERS ─────────────────────────────────────────────────────────

describe('RESET_TRIGGERS', () => {
  const triggers = ['reset', 'start over', 'new gift', 'restart', 'clear', 'begin again'];
  const nonTriggers = ['hello', 'I want to buy a gift', 'search again'];

  triggers.forEach((str) => {
    it(`matches "${str}"`, () => {
      expect(RESET_TRIGGERS.test(str)).toBe(true);
    });
  });

  nonTriggers.forEach((str) => {
    it(`does not match "${str}"`, () => {
      expect(RESET_TRIGGERS.test(str)).toBe(false);
    });
  });
});
