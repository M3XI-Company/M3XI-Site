/**
 * Deterministic ids, so an interrupted ingest can be re-sent.
 *
 * A worker that dies halfway through handing us a world gets its job reclaimed
 * and starts again. If every row it sent the first time got a fresh uuid on the
 * second pass, the world would end up with two of every surface, two of every
 * camera and a nav graph with twice the nodes — and nothing would error,
 * because none of those tables has a natural unique key.
 *
 * So every row's primary key is derived from (world id, section, the
 * document's own local id). Re-sending the same row computes the same uuid and
 * updates in place. The pipeline's local ids are already stable across a
 * re-run: rooms and entities carry a `stableKey`, surfaces are `srf_000`,
 * cameras are their frame id, and so on.
 *
 * The output is formatted as a v5 uuid — version nibble 5, RFC 4122 variant —
 * because the column is `uuid` and a value that does not parse as one is a
 * runtime error in Postgres rather than a design discussion. It is SHA-256
 * truncated rather than SHA-1, which is not RFC 4122's algorithm; the shape is
 * what the column needs, and nothing depends on being able to recompute it
 * with a stock uuid5 implementation.
 */

const encoder = new TextEncoder();

export async function sha256Bytes(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text) as unknown as ArrayBuffer);
  return new Uint8Array(digest);
}

export async function sha256Hex(text: string): Promise<string> {
  return [...await sha256Bytes(text)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A uuid that is a pure function of (worldId, section, localId).
 *
 * worldId is part of the input, so the same local id in two different worlds
 * never collides — which matters because 'srf_000' is the first surface of
 * every world ever reconstructed.
 */
export async function deterministicId(
  worldId: string, section: string, localId: string,
): Promise<string> {
  const bytes = await sha256Bytes(`${worldId}\u0000${section}\u0000${localId}`);
  const b = bytes.slice(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50;   // version 5
  b[8] = (b[8]! & 0x3f) | 0x80;   // RFC 4122 variant
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
