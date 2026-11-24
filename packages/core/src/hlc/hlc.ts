/**
 * Hybrid Logical Clock (ENG-7, ADR-0003).
 *
 * Every device keeps one HLC and stamps each locally changed field with it. Timestamps are
 * totally ordered by (wall time, counter, device ID), so two devices never produce equal stamps
 * and every device sorts the same edits the same way, even when clocks drift.
 *
 * All functions are pure: the current time is passed in, and the caller persists the latest HLC.
 * Reference: Kulkarni, Demirbas et al., "Logical Physical Clocks and Consistent Snapshots in
 * Globally Distributed Databases" (2014).
 */

export interface Hlc {
  /** Milliseconds since the Unix epoch: the highest physical time this clock has seen. */
  readonly wallTime: number;
  /** Orders events that share a wall time. Resets to 0 whenever the wall time advances. */
  readonly counter: number;
  /** Device ID of the clock's owner (ACC-7). Breaks ties between devices. */
  readonly deviceId: string;
}

/** Largest wall time that fits the 15-digit serialized field (about year 33658). */
export const MAX_WALL_TIME = 999_999_999_999_999;
/** Largest counter that fits the 8-hex-digit serialized field. */
export const MAX_COUNTER = 0xffff_ffff;
/**
 * Default limit for how far a remote HLC may be ahead of the local clock in `receive`.
 * A stamp further ahead is almost certainly a broken clock; adopting it would drag this device's
 * clock into the future and let its edits win every conflict.
 */
export const DEFAULT_MAX_DRIFT_MS = 24 * 60 * 60 * 1000;
/** Warn the user when the local clock differs from the server's `Date` header by more (ADR-0003). */
export const CLOCK_SKEW_WARNING_MS = 5 * 60 * 1000;

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SERIALIZED_PATTERN = /^(\d{15}):([0-9a-f]{8}):([A-Za-z0-9_-]{1,64})$/;

/** A remote HLC is further ahead of the local clock than the allowed drift. */
export class HlcDriftError extends Error {
  readonly driftMs: number;

  constructor(driftMs: number) {
    super(`Remote HLC is ${String(driftMs)} ms ahead of the local clock`);
    this.name = 'HlcDriftError';
    this.driftMs = driftMs;
  }
}

/** The counter would exceed MAX_COUNTER within a single millisecond of wall time. */
export class HlcOverflowError extends Error {
  constructor() {
    super('HLC counter overflow');
    this.name = 'HlcOverflowError';
  }
}

function assertWallTime(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_WALL_TIME) {
    throw new RangeError(`${name} must be an integer between 0 and ${String(MAX_WALL_TIME)}`);
  }
}

function assertDeviceId(deviceId: string): void {
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new RangeError('deviceId must be 1–64 base64url characters');
  }
}

function assertHlc(hlc: Hlc, name: string): void {
  assertWallTime(hlc.wallTime, `${name}.wallTime`);
  if (!Number.isSafeInteger(hlc.counter) || hlc.counter < 0 || hlc.counter > MAX_COUNTER) {
    throw new RangeError(`${name}.counter must be an integer between 0 and ${String(MAX_COUNTER)}`);
  }
  assertDeviceId(hlc.deviceId);
}

function make(wallTime: number, counter: number, deviceId: string): Hlc {
  if (counter > MAX_COUNTER) {
    throw new HlcOverflowError();
  }
  return { wallTime, counter, deviceId };
}

/** The initial clock of a new device. It sorts before every stamp the device will produce. */
export function createHlc(deviceId: string): Hlc {
  assertDeviceId(deviceId);
  return { wallTime: 0, counter: 0, deviceId };
}

/**
 * Advance the clock for a local change. The result is strictly greater than `clock`,
 * even if the physical clock went backwards.
 */
export function tick(clock: Hlc, now: number): Hlc {
  assertHlc(clock, 'clock');
  assertWallTime(now, 'now');
  if (now > clock.wallTime) {
    return make(now, 0, clock.deviceId);
  }
  return make(clock.wallTime, clock.counter + 1, clock.deviceId);
}

export interface ReceiveOptions {
  /** Reject remote stamps more than this far ahead of `now`. Defaults to DEFAULT_MAX_DRIFT_MS. */
  readonly maxDriftMs?: number;
}

/**
 * Merge a remote stamp into the local clock after applying a remote change. The result keeps the
 * local device ID and is strictly greater than both `clock` and `remote`, so the next local edit
 * orders after everything this device has seen.
 *
 * Throws HlcDriftError when `remote` is too far in the future; the caller should then keep its
 * clock unchanged and warn the user rather than adopt the remote time.
 */
export function receive(clock: Hlc, remote: Hlc, now: number, options: ReceiveOptions = {}): Hlc {
  assertHlc(clock, 'clock');
  assertHlc(remote, 'remote');
  assertWallTime(now, 'now');

  const maxDriftMs = options.maxDriftMs ?? DEFAULT_MAX_DRIFT_MS;
  const drift = remote.wallTime - now;
  if (drift > maxDriftMs) {
    throw new HlcDriftError(drift);
  }

  const wallTime = Math.max(clock.wallTime, remote.wallTime, now);
  let counter: number;
  if (wallTime === clock.wallTime && wallTime === remote.wallTime) {
    counter = Math.max(clock.counter, remote.counter) + 1;
  } else if (wallTime === clock.wallTime) {
    counter = clock.counter + 1;
  } else if (wallTime === remote.wallTime) {
    counter = remote.counter + 1;
  } else {
    counter = 0;
  }
  return make(wallTime, counter, clock.deviceId);
}

/** Total order: negative if `a` is earlier, positive if later, 0 only for identical stamps. */
export function compare(a: Hlc, b: Hlc): number {
  if (a.wallTime !== b.wallTime) {
    return a.wallTime < b.wallTime ? -1 : 1;
  }
  if (a.counter !== b.counter) {
    return a.counter < b.counter ? -1 : 1;
  }
  if (a.deviceId !== b.deviceId) {
    return a.deviceId < b.deviceId ? -1 : 1;
  }
  return 0;
}

/**
 * Encode as `<wallTime, 15 decimal digits>:<counter, 8 hex digits>:<deviceId>`.
 * The fields are fixed-width, so comparing two serialized stamps as strings gives the same
 * result as `compare`. This is a stored format: changing it needs a migration.
 */
export function serialize(hlc: Hlc): string {
  assertHlc(hlc, 'hlc');
  const wall = String(hlc.wallTime).padStart(15, '0');
  const counter = hlc.counter.toString(16).padStart(8, '0');
  return `${wall}:${counter}:${hlc.deviceId}`;
}

/** Decode a stamp produced by `serialize`. Throws RangeError for anything else. */
export function parse(value: string): Hlc {
  const match = SERIALIZED_PATTERN.exec(value);
  if (!match) {
    throw new RangeError('Not a serialized HLC');
  }
  const [, wall, counter, deviceId] = match as unknown as [string, string, string, string];
  return { wallTime: Number(wall), counter: Number.parseInt(counter, 16), deviceId };
}

/**
 * Local clock minus server clock, in ms, from the server's `Date` header. Positive means the
 * local clock is ahead. The header has 1-second resolution, so results within ±1000 ms are noise.
 */
export function clockSkewMs(localNow: number, serverDate: number): number {
  return localNow - serverDate;
}

/** Whether the skew is large enough to warn the user (more than CLOCK_SKEW_WARNING_MS). */
export function isClockSkewed(localNow: number, serverDate: number): boolean {
  return Math.abs(clockSkewMs(localNow, serverDate)) > CLOCK_SKEW_WARNING_MS;
}
