import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CLOCK_SKEW_WARNING_MS,
  DEFAULT_MAX_DRIFT_MS,
  type Hlc,
  HlcDriftError,
  HlcOverflowError,
  MAX_COUNTER,
  MAX_WALL_TIME,
  compare,
  createHlc,
  isClockSkewed,
  isSerializedHlc,
  parse,
  receive,
  serialize,
  tick,
} from './hlc.ts';

const T = 1_795_000_000_000; // 2026-11-18, an arbitrary fixed "now"

const deviceIdArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/);
const wallTimeArb = fc.integer({ min: 0, max: MAX_WALL_TIME });
const hlcArb: fc.Arbitrary<Hlc> = fc.record({
  wallTime: wallTimeArb,
  counter: fc.integer({ min: 0, max: MAX_COUNTER - 1 }),
  deviceId: deviceIdArb,
});
const collidingHlcArb: fc.Arbitrary<Hlc> = fc.record({
  wallTime: fc.integer({ min: 0, max: 2 }),
  counter: fc.integer({ min: 0, max: 2 }),
  deviceId: fc.constantFrom('a', 'b', 'c'),
});
const sign = (n: number) => Math.sign(n);

describe('createHlc', () => {
  it('starts at zero', () => {
    expect(createHlc('dev-a')).toEqual({ wallTime: 0, counter: 0, deviceId: 'dev-a' });
  });

  it.each(['', 'has space', 'ü', 'a'.repeat(65), 'a:b'])('rejects device ID %j', (id) => {
    expect(() => createHlc(id)).toThrow(RangeError);
  });
});

describe('tick', () => {
  it('adopts the physical time when it moves forward', () => {
    const h = tick(createHlc('a'), T);
    expect(h).toEqual({ wallTime: T, counter: 0, deviceId: 'a' });
    expect(tick(h, T + 5)).toEqual({ wallTime: T + 5, counter: 0, deviceId: 'a' });
  });

  it('increments the counter within the same millisecond', () => {
    const h = tick(tick(tick(createHlc('a'), T), T), T);
    expect(h).toEqual({ wallTime: T, counter: 2, deviceId: 'a' });
  });

  it('stays monotonic when the physical clock goes backwards', () => {
    const h = tick(createHlc('a'), T);
    const back = tick(h, T - 60_000);
    expect(back).toEqual({ wallTime: T, counter: 1, deviceId: 'a' });
    expect(compare(back, h)).toBe(1);
  });

  it('throws on counter overflow instead of wrapping', () => {
    const full: Hlc = { wallTime: T, counter: MAX_COUNTER, deviceId: 'a' };
    expect(() => tick(full, T)).toThrow(HlcOverflowError);
  });

  it.each([Number.NaN, -1, 1.5, MAX_WALL_TIME + 1])('rejects now = %d', (now) => {
    expect(() => tick(createHlc('a'), now)).toThrow(RangeError);
  });

  it('is strictly increasing for any sequence of physical times', () => {
    fc.assert(
      fc.property(
        deviceIdArb,
        fc.array(wallTimeArb, { minLength: 1, maxLength: 50 }),
        (id, times) => {
          let clock = createHlc(id);
          for (const now of times) {
            const next = tick(clock, now);
            expect(compare(next, clock)).toBe(1);
            expect(next.wallTime).toBeGreaterThanOrEqual(now);
            clock = next;
          }
        },
      ),
    );
  });
});

describe('receive', () => {
  it('keeps the local device ID', () => {
    const remote: Hlc = { wallTime: T, counter: 3, deviceId: 'b' };
    expect(receive(createHlc('a'), remote, T - 10).deviceId).toBe('a');
  });

  it('uses the physical time when it is ahead of both stamps', () => {
    const local: Hlc = { wallTime: T, counter: 7, deviceId: 'a' };
    const remote: Hlc = { wallTime: T + 1, counter: 9, deviceId: 'b' };
    expect(receive(local, remote, T + 100)).toEqual({
      wallTime: T + 100,
      counter: 0,
      deviceId: 'a',
    });
  });

  it('continues from the remote counter when the remote is ahead', () => {
    const local: Hlc = { wallTime: T, counter: 7, deviceId: 'a' };
    const remote: Hlc = { wallTime: T + 50, counter: 9, deviceId: 'b' };
    expect(receive(local, remote, T)).toEqual({ wallTime: T + 50, counter: 10, deviceId: 'a' });
  });

  it('continues from the local counter when the local clock is ahead', () => {
    const local: Hlc = { wallTime: T + 50, counter: 7, deviceId: 'a' };
    const remote: Hlc = { wallTime: T, counter: 9, deviceId: 'b' };
    expect(receive(local, remote, T)).toEqual({ wallTime: T + 50, counter: 8, deviceId: 'a' });
  });

  it('takes the larger counter when wall times are equal', () => {
    const local: Hlc = { wallTime: T, counter: 2, deviceId: 'a' };
    const remote: Hlc = { wallTime: T, counter: 9, deviceId: 'b' };
    expect(receive(local, remote, T - 1)).toEqual({ wallTime: T, counter: 10, deviceId: 'a' });
  });

  it('orders the next local edit after a remote edit from a clock that runs ahead', () => {
    // Device B's clock is 10 minutes fast. A applies B's edit, then edits the same field.
    const b = tick(createHlc('b'), T + 10 * 60_000);
    let a = tick(createHlc('a'), T);
    expect(compare(a, b)).toBe(-1);
    a = receive(a, b, T + 1);
    const aEdit = tick(a, T + 2);
    expect(compare(aEdit, b)).toBe(1);
  });

  it('rejects stamps further ahead than the allowed drift', () => {
    const remote: Hlc = { wallTime: T + DEFAULT_MAX_DRIFT_MS + 1, counter: 0, deviceId: 'b' };
    expect(() => receive(createHlc('a'), remote, T)).toThrow(HlcDriftError);
    expect(() =>
      receive(createHlc('a'), remote, T, { maxDriftMs: 2 * DEFAULT_MAX_DRIFT_MS }),
    ).not.toThrow();
  });

  it('accepts stamps exactly at the drift limit', () => {
    const remote: Hlc = { wallTime: T + 1000, counter: 0, deviceId: 'b' };
    expect(() => receive(createHlc('a'), remote, T, { maxDriftMs: 1000 })).not.toThrow();
  });

  it('is strictly greater than both inputs', () => {
    fc.assert(
      fc.property(hlcArb, hlcArb, wallTimeArb, (local, remote, now) => {
        fc.pre(remote.wallTime - now <= DEFAULT_MAX_DRIFT_MS);
        fc.pre(local.counter < MAX_COUNTER - 1 && remote.counter < MAX_COUNTER - 1);
        const next = receive(local, remote, now);
        expect(compare(next, local)).toBe(1);
        // Greater than the remote in (wallTime, counter), so greater regardless of device ID.
        expect(next.wallTime > remote.wallTime || next.counter > remote.counter).toBe(true);
      }),
    );
  });
});

describe('receive with colliding stamps', () => {
  it('is strictly greater than both inputs when wall times and counters collide', () => {
    fc.assert(
      fc.property(collidingHlcArb, collidingHlcArb, fc.integer({ min: 0, max: 3 }), (l, r, now) => {
        const next = receive(l, r, now);
        expect(compare(next, l)).toBe(1);
        expect(next.wallTime > r.wallTime || next.counter > r.counter).toBe(true);
      }),
    );
  });
});

describe('compare', () => {
  it('orders by wall time, then counter, then device ID', () => {
    const base: Hlc = { wallTime: T, counter: 5, deviceId: 'm' };
    expect(compare(base, { ...base, wallTime: T + 1, counter: 0 })).toBe(-1);
    expect(compare(base, { ...base, counter: 6, deviceId: 'a' })).toBe(-1);
    expect(compare(base, { ...base, deviceId: 'n' })).toBe(-1);
    expect(compare(base, { ...base, deviceId: 'a' })).toBe(1);
    expect(compare(base, { ...base })).toBe(0);
  });

  it('is antisymmetric and returns 0 only for identical stamps', () => {
    fc.assert(
      fc.property(hlcArb, hlcArb, (a, b) => {
        expect(compare(a, b)).toBe(-compare(b, a));
        expect(compare(a, b) === 0).toBe(
          a.wallTime === b.wallTime && a.counter === b.counter && a.deviceId === b.deviceId,
        );
      }),
    );
  });

  it('is transitive', () => {
    fc.assert(
      // Small domains so that equal wall times and counters (the tie-break paths) are common.
      fc.property(collidingHlcArb, collidingHlcArb, collidingHlcArb, (a, b, c) => {
        for (const [x, y, z] of [
          [a, b, c],
          [a, c, b],
          [b, a, c],
          [b, c, a],
          [c, a, b],
          [c, b, a],
        ] as const) {
          if (compare(x, y) <= 0 && compare(y, z) <= 0) {
            expect(compare(x, z)).toBeLessThanOrEqual(0);
          }
        }
      }),
    );
  });
});

describe('serialize and parse', () => {
  it('uses a fixed-width, readable format', () => {
    expect(serialize({ wallTime: T, counter: 255, deviceId: 'dev_A-1' })).toBe(
      '001795000000000:000000ff:dev_A-1',
    );
  });

  it('round-trips', () => {
    fc.assert(
      fc.property(hlcArb, (h) => {
        expect(parse(serialize(h))).toEqual(h);
      }),
    );
  });

  it('sorts as strings in the same order as compare', () => {
    fc.assert(
      fc.property(hlcArb, hlcArb, (a, b) => {
        const sa = serialize(a);
        const sb = serialize(b);
        const stringOrder = sa < sb ? -1 : sa > sb ? 1 : 0;
        expect(stringOrder).toBe(sign(compare(a, b)));
      }),
    );
  });

  it.each([
    '',
    '1795000000000:000000ff:a', // wall time not padded
    '001795000000000:FF:a', // counter not padded
    '001795000000000:000000FF:a', // uppercase hex
    '001795000000000:000000ff:', // empty device ID
    '001795000000000:000000ff:a b',
    ' 001795000000000:000000ff:a',
  ])('rejects %j', (value) => {
    expect(() => parse(value)).toThrow(RangeError);
  });
});

describe('isClockSkewed', () => {
  it('warns only beyond five minutes in either direction', () => {
    expect(isClockSkewed(T + CLOCK_SKEW_WARNING_MS, T)).toBe(false);
    expect(isClockSkewed(T - CLOCK_SKEW_WARNING_MS, T)).toBe(false);
    expect(isClockSkewed(T + CLOCK_SKEW_WARNING_MS + 1, T)).toBe(true);
    expect(isClockSkewed(T - CLOCK_SKEW_WARNING_MS - 1, T)).toBe(true);
  });
});

describe('isSerializedHlc', () => {
  it('matches exactly what serialize produces', () => {
    fc.assert(
      fc.property(hlcArb, (h) => {
        expect(isSerializedHlc(serialize(h))).toBe(true);
      }),
    );
    expect(isSerializedHlc('001795000000000:000000FF:a')).toBe(false);
    expect(isSerializedHlc('')).toBe(false);
  });
});
