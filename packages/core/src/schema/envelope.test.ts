import { describe, expect, it } from 'vitest';
import {
  MAX_BATCH_RECORDS,
  errorResponse,
  pullResponse,
  pushRequest,
  recordEnvelope,
} from './envelope.ts';

// Smallest valid payload: 28 bytes (nonce + tag) of base64url.
const PAYLOAD = 'A'.repeat(38);

describe('recordEnvelope', () => {
  it('accepts the example from SRS 4.4.2', () => {
    const record = {
      id: 'b64url_ID-1',
      seq: 18234,
      modifiedAt: '2026-11-24T10:00:00Z',
      expiresAt: '2027-11-24T00:00:00Z',
      payload: PAYLOAD,
    };
    expect(recordEnvelope.parse(record)).toEqual(record);
  });

  it('rejects payloads shorter than nonce plus tag, and non-base64url payloads', () => {
    const base = { id: 'a', seq: 1, modifiedAt: '2026-11-24T10:00:00Z' };
    expect(recordEnvelope.safeParse({ ...base, payload: PAYLOAD.slice(1) }).success).toBe(false);
    expect(recordEnvelope.safeParse({ ...base, payload: `${PAYLOAD}=` }).success).toBe(false);
    expect(recordEnvelope.safeParse({ ...base, payload: `${PAYLOAD}+/` }).success).toBe(false);
  });

  it('rejects IDs longer than 64 characters', () => {
    const record = {
      id: 'a'.repeat(65),
      seq: 1,
      modifiedAt: '2026-11-24T10:00:00Z',
      payload: PAYLOAD,
    };
    expect(recordEnvelope.safeParse(record).success).toBe(false);
  });
});

describe('pushRequest', () => {
  it(`accepts 1 to ${String(MAX_BATCH_RECORDS)} records`, () => {
    const record = { id: 'a', payload: PAYLOAD };
    expect(pushRequest.safeParse([]).success).toBe(false);
    expect(pushRequest.safeParse(Array(MAX_BATCH_RECORDS).fill(record)).success).toBe(true);
    expect(pushRequest.safeParse(Array(MAX_BATCH_RECORDS + 1).fill(record)).success).toBe(false);
  });

  it('does not let the client set seq or modifiedAt', () => {
    const parsed = pushRequest.parse([
      { id: 'a', payload: PAYLOAD, seq: 5, modifiedAt: '2026-11-24T10:00:00Z' },
    ]);
    expect(parsed).toEqual([{ id: 'a', payload: PAYLOAD }]);
  });
});

describe('pullResponse and errorResponse', () => {
  it('parse the documented shapes', () => {
    expect(pullResponse.safeParse({ records: [], nextSince: 0, more: false }).success).toBe(true);
    expect(
      errorResponse.safeParse({
        error: { code: 'QUOTA_EXCEEDED', message: 'Quota', retryAfter: 30 },
      }).success,
    ).toBe(true);
    expect(errorResponse.safeParse({ error: { code: 'quota', message: '' } }).success).toBe(false);
  });
});
