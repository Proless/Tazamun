/**
 * Whole-record last-writer-wins (ADR-0003, strategy for records owned by one device: tabs,
 * extension inventory). The payload with the larger HLC wins; a tie is broken by the
 * canonical JSON, so every device picks the same winner whatever order it sees the two in.
 *
 * Commutative, associative and idempotent (property-tested), which is what makes devices converge
 * (REL-6). Modules that merge per field (bookmarks) or by union (history) bring their own.
 */
import { compare, parse } from '../hlc/index.ts';
import type { Payload } from '../schema/index.ts';
import { canonicalJson } from './canonical.ts';

export function lastWriterWins<Data>(
  local: Payload<Data> | undefined,
  remote: Payload<Data>,
): Payload<Data> {
  if (local === undefined) return remote;
  const order = compare(parse(local.hlc), parse(remote.hlc));
  if (order !== 0) return order > 0 ? local : remote;
  const a = canonicalJson(local);
  const b = canonicalJson(remote);
  return a >= b ? local : remote;
}
