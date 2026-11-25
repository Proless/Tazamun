import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { serialize } from '../hlc/index.ts';
import type { Payload } from '../schema/index.ts';
import { canonicalJson, jsonEqual, lastWriterWins } from './index.ts';

/** Small domains, so equal stamps and ties actually occur. */
const payloadArb: fc.Arbitrary<Payload<{ n: number }>> = fc
  .record({
    wallTime: fc.integer({ min: 0, max: 3 }),
    counter: fc.integer({ min: 0, max: 2 }),
    deviceId: fc.constantFrom('dev_A', 'dev_B', 'dev_C'),
    deleted: fc.boolean(),
    n: fc.integer({ min: 0, max: 2 }),
  })
  .map(({ wallTime, counter, deviceId, deleted, n }) => {
    const hlc = serialize({ wallTime, counter, deviceId });
    return deleted
      ? { v: 1, deleted: true as const, hlc }
      : { v: 1, deleted: false as const, hlc, data: { n } };
  });

describe('lastWriterWins (REL-6)', () => {
  it('takes the remote record when there is no local one', () => {
    fc.assert(
      fc.property(payloadArb, (remote) => {
        expect(lastWriterWins(undefined, remote)).toBe(remote);
      }),
    );
  });

  it('is commutative', () => {
    fc.assert(
      fc.property(payloadArb, payloadArb, (a, b) => {
        expect(canonicalJson(lastWriterWins(a, b))).toBe(canonicalJson(lastWriterWins(b, a)));
      }),
    );
  });

  it('is associative', () => {
    fc.assert(
      fc.property(payloadArb, payloadArb, payloadArb, (a, b, c) => {
        const left = lastWriterWins(lastWriterWins(a, b), c);
        const right = lastWriterWins(a, lastWriterWins(b, c));
        expect(canonicalJson(left)).toBe(canonicalJson(right));
      }),
    );
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(payloadArb, (a) => {
        expect(lastWriterWins(a, a)).toBe(a);
      }),
    );
  });

  it('converges whatever order three devices see the edits in', () => {
    fc.assert(
      fc.property(fc.array(payloadArb, { minLength: 1, maxLength: 6 }), (edits) => {
        const forward = edits.reduce<Payload<{ n: number }> | undefined>(
          (acc, e) => lastWriterWins(acc, e),
          undefined,
        );
        const backward = [...edits]
          .reverse()
          .reduce<Payload<{ n: number }> | undefined>(
            (acc, e) => lastWriterWins(acc, e),
            undefined,
          );
        expect(canonicalJson(forward)).toBe(canonicalJson(backward));
      }),
    );
  });

  it('lets a later edit win, including a deletion', () => {
    const older = {
      v: 1,
      deleted: false as const,
      hlc: serialize({ wallTime: 1, counter: 0, deviceId: 'a' }),
      data: { n: 1 },
    };
    const newer = {
      v: 1,
      deleted: true as const,
      hlc: serialize({ wallTime: 2, counter: 0, deviceId: 'a' }),
    };
    expect(lastWriterWins(older, newer)).toBe(newer);
    expect(lastWriterWins(newer, older)).toBe(newer);
  });
});

describe('canonicalJson', () => {
  it('ignores key order and undefined properties', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"x":1,"y":2}]},"b":1}',
    );
    expect(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
  });
});
