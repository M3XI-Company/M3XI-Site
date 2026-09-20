/**
 * The cacheable prefix.
 *
 * Two strings, both identical on every turn of a session, both marked
 * cacheable at the provider: the system prompt (identical across every session
 * of a deployment) and the scene-graph digest (identical across every turn of
 * one world). Together they are the overwhelming majority of the input tokens
 * on a chat turn, because the question itself is twenty tokens and the
 * property is thousands.
 *
 * This is why they are built here, once, from the world document, and never
 * assembled ad hoc at a call site: a prefix that varies by a single character
 * between turns misses the cache, and a missed cache is roughly a third more
 * cost on every turn for the rest of the session.
 */

import type { WorldDocument } from '@m3xi/world-core';
import { World, math } from '@m3xi/spatial-engine';

/**
 * The rules the model operates under. Written as constraints rather than
 * encouragement, because a model told to "try to be accurate" will be
 * plausible instead.
 */
export const SYSTEM_PROMPT = [
  'You answer questions about a specific property that has been scanned and reconstructed in 3D.',
  '',
  'You have no knowledge of this property beyond the tool results supplied to you.',
  'Every statement you make must be supported by a tool result in this turn.',
  'If the tool results do not settle the question, say that the capture does not establish it,',
  'and say what would: a survey, an EPC, the agent, a second scan.',
  '',
  'Never estimate a dimension, an area, a material, a build date, a tenure, a service charge,',
  'a glazing specification or a boiler age. Reconstruction recovers shape and position.',
  'It does not recover what something is made of, how old it is, or what it costs.',
  '',
  'Quote every measurement with its tolerance exactly as the tool result gives it.',
  'Quote every area with its measurement standard. Do not round a tolerance away.',
  '',
  'Some parts of this capture were never observed by a camera. Where a tool result says so,',
  'refuse the question rather than answering from the geometry that was filled in.',
  '',
  'Be brief. A buyer asked a question; answer it and stop.',
].join('\n');

export interface ContextOptions {
  /** Cap on entities listed per room. A digest, not a dump. */
  readonly maxEntitiesPerRoom?: number;
}

/**
 * A compact, stable description of the world for the model's cached prefix.
 *
 * Deterministic ordering throughout: the same world always produces byte-identical
 * output, which is what makes the cache hit.
 */
export function buildSceneContext(world: World, opts: ContextOptions = {}): string {
  const doc: WorldDocument = world.doc;
  const cap = opts.maxEntitiesPerRoom ?? 12;
  const lines: string[] = [];

  lines.push(`PROPERTY: ${doc.label}`);
  lines.push(`World ${doc.id} version ${doc.version}, captured ${doc.createdAt.slice(0, 10)}.`);
  lines.push(`Measurement policy: ${doc.measurementPolicy.areaStandard}, area tolerance ±${doc.measurementPolicy.areaTolerancePct}%, wall tolerance ±${doc.measurementPolicy.wallToleranceMm} mm.`);
  lines.push(`Metric scale fixed by ${doc.scale.source}, estimator agreement ${doc.scale.agreement}.`);
  lines.push(`Quality verdict: ${doc.quality.verdict} (score ${doc.quality.score}).`);
  lines.push('');

  lines.push('ROOMS');
  for (const r of [...doc.rooms].sort((a, b) => a.id.localeCompare(b.id))) {
    const ring = math.sanitiseRing(r.polygon);
    const area = ring.length >= 3 ? math.ringArea(ring) : 0;
    const height = (Number.isFinite(r.ceilingZ) ? r.ceilingZ : 2.4) - (Number.isFinite(r.floorZ) ? r.floorZ : 0);
    lines.push(`- ${r.id} "${r.name ?? r.kind}" kind=${r.kind} area=${area.toFixed(2)}m2 ceiling=${height.toFixed(2)}m provenance=${r.grounding.provenance} confidence=${r.grounding.confidence}`);
    const ents = world.entitiesIn(r.id).slice(0, cap);
    if (ents.length > 0) {
      lines.push(`  contains: ${ents.map((e) => `${e.label}[${e.id}]`).join(', ')}`);
    }
  }
  lines.push('');

  lines.push('OPENINGS');
  for (const o of [...doc.openings].sort((a, b) => a.id.localeCompare(b.id))) {
    const between = o.roomB ? `${o.roomA}<->${o.roomB}` : `${o.roomA ?? 'exterior'}`;
    lines.push(`- ${o.id} ${o.kind} ${between} width=${o.width?.value.toFixed(3) ?? '?'}m height=${o.height?.value.toFixed(3) ?? '?'}m`);
  }
  lines.push('');

  // The unobserved list is the most important part of this context. A model
  // that does not know where the holes are will answer confidently inside one.
  const soft = doc.regions.filter((r) => r.provenance !== 'observed');
  lines.push('REGIONS NOT OBSERVED BY ANY CAMERA');
  if (soft.length === 0) {
    lines.push('- none; the whole property was observed');
  } else {
    for (const r of [...soft].sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`- ${r.id} ${r.provenance} room=${r.roomId ?? 'n/a'} reason="${r.reason ?? 'unstated'}" — REFUSE questions that depend on this volume`);
    }
  }
  lines.push('');

  lines.push('CONNECTIVITY');
  for (const r of [...doc.rooms].sort((a, b) => a.id.localeCompare(b.id))) {
    const rels = world.relationships(r.id, 'connected_to');
    if (rels.length === 0) continue;
    lines.push(`- ${r.id} connects to ${rels.map((x) => x.objectId).sort().join(', ')}`);
  }

  return lines.join('\n');
}

/** Cheap fingerprint used to decide whether a cached prefix is still valid. */
export function contextKey(doc: WorldDocument): string {
  return `${doc.id}:${doc.version}:${doc.rooms.length}:${doc.entities.length}:${doc.regions.length}`;
}
