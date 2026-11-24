import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { COLLECTIONS, history, tabs } from './collections/index.ts';
import {
  COLLECTION_NAMES,
  decodePayload,
  defineCollection,
  livePayload,
  tombstonePayload,
} from './payload.ts';

const HLC = '001795000000000:000000ff:dev_A-1';
const tabsData = {
  windows: [
    {
      focused: true,
      tabs: [{ url: 'https://example.org/', title: 'Example', pinned: false, active: true }],
    },
  ],
};

/** Encrypt/decrypt is a JSON round trip from the schema's point of view. */
const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('decodePayload', () => {
  it('accepts a live payload', () => {
    const payload = livePayload(tabs, HLC, tabsData);
    expect(decodePayload(tabs, roundTrip(payload))).toEqual({ status: 'ok', payload });
  });

  it('accepts a tombstone without data', () => {
    const payload = tombstonePayload(tabs, HLC);
    expect(payload).toEqual({ v: 1, deleted: true, hlc: HLC });
    expect(decodePayload(tabs, roundTrip(payload))).toEqual({ status: 'ok', payload });
  });

  it('reports a newer major version instead of rejecting it (ENG-10)', () => {
    const payload = { v: 2, deleted: false, hlc: HLC, data: { anything: 'new' } };
    expect(decodePayload(tabs, payload)).toEqual({ status: 'newer-version', version: 2 });
  });

  it('rejects an older version until a migration exists', () => {
    const v2 = defineCollection({ name: 'tabs', version: 2, data: z.looseObject({}) });
    const result = decodePayload(v2, { v: 1, deleted: true, hlc: HLC });
    expect(result).toEqual({
      status: 'invalid',
      issues: [{ path: ['v'], code: 'unsupported_version' }],
    });
  });

  it('rejects a live payload without data, and a bad HLC', () => {
    expect(decodePayload(tabs, { v: 1, deleted: false, hlc: HLC }).status).toBe('invalid');
    expect(decodePayload(tabs, { v: 1, deleted: true, hlc: 'yesterday' }).status).toBe('invalid');
  });

  it('keeps fields it does not know, at every level, so a re-push loses nothing', () => {
    const fromNewerClient = {
      v: 1,
      deleted: false,
      hlc: HLC,
      futureEnvelopeField: 1,
      data: {
        futureDataField: 'x',
        windows: [
          {
            focused: false,
            futureWindowField: [1],
            tabs: [{ ...tabsData.windows[0]?.tabs[0], muted: true }],
          },
        ],
      },
    };
    const result = decodePayload(tabs, fromNewerClient);
    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && roundTrip(result.payload)).toEqual(fromNewerClient);
  });

  it('reports where a problem is without echoing the value (no plaintext in logs)', () => {
    const secretUrl = 'https://secret.example/private-page';
    const result = decodePayload(history, {
      v: 1,
      deleted: false,
      hlc: HLC,
      data: { url: secretUrl, title: 7, visits: [] },
    });
    expect(result.status).toBe('invalid');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.status === 'invalid' && result.issues).toEqual([
      { path: ['data', 'title'], code: 'invalid_type' },
    ]);
  });

  it('never throws, whatever a server or a buggy client sends', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        for (const collection of Object.values(COLLECTIONS)) {
          expect(() => decodePayload(collection, value)).not.toThrow();
        }
      }),
    );
  });
});

describe('livePayload and tombstonePayload', () => {
  it('stamp the current version and validate their input', () => {
    expect(livePayload(tabs, HLC, tabsData).v).toBe(tabs.version);
    expect(() => livePayload(tabs, 'not-an-hlc', tabsData)).toThrow();
    expect(() => livePayload(tabs, HLC, { windows: 'none' } as never)).toThrow();
    expect(() => tombstonePayload(tabs, '')).toThrow();
  });
});

describe('COLLECTIONS', () => {
  it('has one schema per collection name, keyed by its own name', () => {
    expect(Object.keys(COLLECTIONS).sort()).toEqual([...COLLECTION_NAMES].sort());
    for (const [key, collection] of Object.entries(COLLECTIONS)) {
      expect(collection.name).toBe(key);
      expect(collection.version).toBeGreaterThanOrEqual(1);
    }
  });
});
