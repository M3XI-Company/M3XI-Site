import type { Provenance, Quat, Vec3 } from '@m3xi/world-core';
import type { World } from '@m3xi/spatial-engine';
import { poseQuat, type MeasurementOverlay } from '../types.js';
import { AGENT_CONTRACT_VERSION } from './contract.js';
import type {
  AgentAction, AgentAnswer, AgentCapabilities, AgentCitation, AgentPort, AgentQuestion,
  AgentRefusal,
} from './contract.js';

/**
 * ADAPTER FOR `@m3xi/agent`
 * =========================
 *
 * The agent package, written in parallel, landed on a different but compatible
 * shape: `Agent.ask(question, ViewerState) -> AskResult`, with a `ViewerCommand`
 * union instead of `AgentAction`. Rather than either side rewriting, this
 * translates between them, and it is the file to delete once we settle on one
 * vocabulary.
 *
 * The types below are declared structurally rather than imported, deliberately.
 * `@m3xi/viewer` must not depend on `@m3xi/agent` -- the viewer has to build
 * and ship with no agent at all -- so this adapter duck-types what it needs
 * and any real `Agent` instance satisfies it. If their union grows a command
 * this file does not know, the turn still answers in text and simply does not
 * animate, which is the degradation their own contract asks for.
 *
 * Two differences worth flagging in review, because they are decisions rather
 * than mismatches:
 *
 * 1. `moveCamera` hands over explicit waypoints and a duration. The viewer
 *    does NOT fly them blind. It takes the destination and re-solves the route
 *    itself, so the camera obeys the same constraint solver a keyboard user
 *    hits. Their waypoints come from `findPath` so the two agree in practice;
 *    when they do not, the building wins.
 * 2. `focusRoom.isolate` (dim everything outside the room) is not applied.
 *    Dimming parts of a photoreal capture changes what the property looks
 *    like, which is the one thing this viewer will not do. The room is
 *    emphasised on the floorplan instead.
 */

// --- the shape we need from @m3xi/agent ------------------------------------

interface ExternalViewerState {
  position: Vec3;
  orientation: Quat;
  fovRad: number;
  selectedEntityId?: string | undefined;
  roomId?: string | undefined;
}

interface ExternalRefusal {
  readonly code: string;
  readonly reason: string;
  readonly evidenceIds?: readonly string[];
}

interface ExternalAnswer {
  readonly text: string;
  readonly refused: boolean;
  readonly refusal?: ExternalRefusal;
  readonly citations: readonly string[];
  readonly grounded: boolean;
}

interface ExternalCommandBase {
  readonly kind: string;
  readonly id: string;
  readonly intent: 'answer' | 'context' | 'navigation';
}

type ExternalCommand = ExternalCommandBase & Record<string, unknown>;

export interface ExternalAskResult {
  readonly answer: ExternalAnswer;
  readonly commands: readonly ExternalCommand[];
}

export interface ExternalAgent {
  ask(question: string, view: ExternalViewerState): Promise<ExternalAskResult>;
}

export interface M3xiAdapterOptions {
  readonly world: World;
  readonly capabilities?: Partial<AgentCapabilities>;
}

// --- the adapter ------------------------------------------------------------

export function adaptM3xiAgent(agent: ExternalAgent, opts: M3xiAdapterOptions): AgentPort {
  const { world } = opts;

  return {
    contractVersion: AGENT_CONTRACT_VERSION,
    capabilities: {
      canAnswer: true,
      canStream: false,
      emits: [
        'camera.goTo', 'camera.lookAt', 'highlight.set', 'highlight.clear',
        'measure.show', 'measure.clear', 'floorplan.emphasise',
      ],
      label: '@m3xi/agent',
      examples: [
        'How big is the kitchen?',
        'Will a 2 m wardrobe fit in bedroom 1?',
        'Take me to the bathroom',
        'What was not surveyed?',
      ],
      ...opts.capabilities,
    },

    async ask(question: AgentQuestion): Promise<AgentAnswer> {
      const result = await agent.ask(question.text, {
        position: question.context.pose.position,
        orientation: poseQuat(question.context.pose),
        fovRad: (60 * Math.PI) / 180,
        selectedEntityId: question.context.selection?.kind === 'entity'
          ? question.context.selection.id : undefined,
        roomId: question.context.roomId,
      });

      const actions = result.commands.flatMap((c) => translate(c, world));
      const refusal = result.answer.refusal
        ? toRefusal(result.answer.refusal)
        : undefined;

      return {
        text: result.answer.text,
        citations: result.answer.citations.map((id) => toCitation(world, id)),
        actions,
        ...(refusal ? { refusal } : {}),
      };
    },
  };
}

// ---------------------------------------------------------------------------

function translate(command: ExternalCommand, world: World): AgentAction[] {
  switch (command.kind) {
    case 'moveCamera': {
      const waypoints = command['waypoints'] as
        | ReadonlyArray<{ position: Vec3; navNodeId?: string }>
        | undefined;
      const last = waypoints?.[waypoints.length - 1];
      if (!last) return [];
      const lookAt = command['lookAt'] as Vec3 | undefined;
      const durationMs = typeof command['durationMs'] === 'number' ? command['durationMs'] : undefined;
      const lengthM = typeof command['pathLengthM'] === 'number' ? command['pathLengthM'] : undefined;
      return [{
        kind: 'camera.goTo',
        // Prefer the nav node: it is a place the engine already blessed, and
        // it survives a viewer that re-solves the route for itself.
        target: last.navNodeId
          ? { kind: 'navNode', nodeId: last.navNodeId }
          : { kind: 'point', position: last.position },
        ...(lookAt ? { lookAt: { kind: 'point' as const, position: lookAt } } : {}),
        style: 'walk',
        ...(durationMs && lengthM && durationMs > 0
          ? { speedMps: lengthM / (durationMs / 1000) }
          : {}),
      }];
    }

    case 'lookAt': {
      const target = command['target'] as Vec3 | undefined;
      return target ? [{ kind: 'camera.lookAt', target: { kind: 'point', position: target } }] : [];
    }

    case 'highlightEntities': {
      const ids = (command['entityIds'] as readonly string[] | undefined) ?? [];
      const style = command['style'] as string | undefined;
      return ids.length === 0 ? [] : [{
        kind: 'highlight.set',
        entityIds: ids,
        // 'warning' means "do not trust this geometry", which this viewer
        // already expresses with the survey hatch. The label carries it into
        // the live region so a screen-reader user gets the same signal.
        ...(style === 'warning'
          ? { label: 'Marked as not fully surveyed' }
          : {}),
      }];
    }

    case 'selectEntity': {
      const id = command['entityId'] as string | undefined;
      return id ? [{ kind: 'highlight.set', entityIds: [id] }] : [];
    }

    case 'focusRoom': {
      const roomId = command['roomId'] as string | undefined;
      return roomId ? [{ kind: 'floorplan.emphasise', roomIds: [roomId] }] : [];
    }

    case 'measurementOverlay': {
      const from = command['from'] as Vec3 | undefined;
      const to = command['to'] as Vec3 | undefined;
      if (!from || !to) return [];
      const defensible = command['defensible'] !== false;
      const label = String(command['label'] ?? '');
      const toleranceMm = command['toleranceMm'];
      return [{
        kind: 'measure.show',
        overlay: {
          id: String(command.id),
          kind: 'distance',
          lines: [[from, to]],
          polygons: [],
          footprints: [],
          labels: [{
            at: midpoint(from, to),
            text: label,
            ...(typeof toleranceMm === 'number' ? { detail: `±${toleranceMm} mm` } : {}),
            status: defensible ? 'defensible' : 'indicative',
          }],
        },
      }];
    }

    case 'areaOverlay': {
      const polygon = command['polygon'] as ReadonlyArray<readonly [number, number]> | undefined;
      const floorY = typeof command['floorY'] === 'number' ? command['floorY'] : 0;
      if (!polygon || polygon.length < 3) return [];
      const ring: Vec3[] = polygon.map((v) => [v[0], floorY + 0.01, v[1]]);
      const defensible = command['defensible'] !== false;
      const standard = command['standard'];
      return [{
        kind: 'measure.show',
        overlay: {
          id: String(command.id),
          kind: 'area',
          lines: [[...ring, ring[0]!]],
          polygons: [ring],
          footprints: [],
          labels: [{
            at: centroid(ring),
            text: String(command['label'] ?? ''),
            ...(typeof standard === 'string' ? { detail: standard } : {}),
            status: defensible ? 'defensible' : 'indicative',
          }],
        },
      }];
    }

    case 'pathOverlay': {
      const points = command['points'] as readonly Vec3[] | undefined;
      if (!points || points.length < 2) return [];
      const label = command['label'];
      return [{
        kind: 'measure.show',
        overlay: {
          id: String(command.id),
          kind: 'distance',
          lines: [points],
          polygons: [],
          footprints: [],
          labels: typeof label === 'string' && label.length > 0
            ? [{ at: points[Math.floor(points.length / 2)]!, text: label, status: 'defensible' }]
            : [],
        },
      }];
    }

    case 'regionOverlay': {
      const ids = (command['regionIds'] as readonly string[] | undefined) ?? [];
      const overlay = regionOverlay(world, String(command.id), ids, String(command['label'] ?? ''));
      return overlay ? [{ kind: 'measure.show', overlay }] : [];
    }

    case 'placementOverlay': {
      const centre = command['centre'] as Vec3 | undefined;
      const half = command['half'] as Vec3 | undefined;
      const quat = (command['quat'] as Quat | undefined) ?? [0, 0, 0, 1];
      if (!centre || !half) return [];
      const fits = command['fits'] !== false;
      const y = centre[1] - half[1] + 0.012;
      return [{
        kind: 'measure.show',
        overlay: {
          id: String(command.id),
          kind: 'fit',
          lines: [],
          polygons: [],
          footprints: [{ corners: floorCorners(centre, half, quat, y), ok: fits }],
          labels: [{
            at: [centre[0], y, centre[2]],
            text: String(command['label'] ?? (fits ? 'Fits' : 'Does not fit')),
            status: fits ? 'defensible' : 'indicative',
          }],
        },
      }];
    }

    case 'clearOverlays': {
      const ids = (command['ids'] as readonly string[] | undefined) ?? [];
      // Their "empty means everything" includes highlights, which the viewer
      // tracks separately.
      return ids.length === 0
        ? [{ kind: 'measure.clear' }, { kind: 'highlight.clear' }]
        : [{ kind: 'measure.clear' }];
    }

    default:
      // A command from a newer agent. Text still lands; the view simply does
      // not animate, which is exactly what their contract asks for.
      return [];
  }
}

function toRefusal(r: ExternalRefusal): AgentRefusal {
  const scope: AgentRefusal['scope'] =
    r.code === 'not_measurable' || r.code === 'not_defensible' || r.code.includes('measur')
      ? 'measurement'
      : r.code === 'out_of_scope' ? 'policy'
      : r.code.includes('unobserved') || r.code.includes('region') ? 'spatial'
      : 'knowledge';
  return {
    scope,
    text: r.reason,
    ...(r.evidenceIds && r.evidenceIds.length > 0 ? { because: r.evidenceIds } : {}),
  };
}

/**
 * Their citations are bare world-object ids. Resolving them here rather than
 * asking them to send labels keeps one source of truth for what a thing is
 * called, and gives the viewer the provenance the citation chip needs.
 */
function toCitation(world: World, id: string): AgentCitation {
  const entity = world.entity(id);
  if (entity) {
    return { kind: 'entity', id, label: entity.label, provenance: entity.grounding.provenance };
  }
  const room = world.room(id);
  if (room) {
    return { kind: 'room', id, label: room.name ?? room.id, provenance: room.grounding.provenance };
  }
  const opening = world.opening(id);
  if (opening) {
    return { kind: 'opening', id, label: opening.kind, provenance: opening.grounding.provenance };
  }
  const surface = world.surface(id);
  if (surface) {
    return { kind: 'surface', id, label: surface.kind, provenance: surface.grounding.provenance };
  }
  const region = world.doc.regions.find((r) => r.id === id);
  if (region) {
    return {
      kind: 'region', id, label: region.reason ?? region.id,
      provenance: region.provenance as Provenance,
    };
  }
  const camera = world.doc.cameras.find((c) => c.id === id);
  if (camera) return { kind: 'camera', id, label: camera.id, provenance: 'observed' };
  return { kind: 'quantity', id, label: id, provenance: 'inferred' };
}

function regionOverlay(
  world: World, id: string, regionIds: readonly string[], label: string,
): MeasurementOverlay | null {
  const polygons: Vec3[][] = [];
  let anchor: Vec3 | undefined;
  for (const regionId of regionIds) {
    const region = world.doc.regions.find((r) => r.id === regionId);
    if (!region) continue;
    const v = region.volume;
    const y = v.min[1] + 0.02;
    polygons.push([
      [v.min[0], y, v.min[2]], [v.max[0], y, v.min[2]],
      [v.max[0], y, v.max[2]], [v.min[0], y, v.max[2]],
    ]);
    anchor ??= [(v.min[0] + v.max[0]) / 2, y, (v.min[2] + v.max[2]) / 2];
  }
  if (polygons.length === 0) return null;
  return {
    id,
    kind: 'area',
    lines: polygons.map((p) => [...p, p[0]!]),
    polygons,
    footprints: [],
    labels: anchor ? [{ at: anchor, text: label, status: 'indicative' }] : [],
  };
}

function floorCorners(centre: Vec3, half: Vec3, quat: Quat, y: number): [Vec3, Vec3, Vec3, Vec3] {
  const yaw = Math.atan2(
    2 * (quat[3] * quat[1] + quat[0] * quat[2]),
    1 - 2 * (quat[1] * quat[1] + quat[0] * quat[0]),
  );
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const at = (sx: number, sz: number): Vec3 => [
    centre[0] + c * (half[0] * sx) + s * (half[2] * sz),
    y,
    centre[2] - s * (half[0] * sx) + c * (half[2] * sz),
  ];
  return [at(1, 1), at(1, -1), at(-1, -1), at(-1, 1)];
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function centroid(ring: readonly Vec3[]): Vec3 {
  let x = 0, y = 0, z = 0;
  for (const p of ring) { x += p[0]; y += p[1]; z += p[2]; }
  const n = Math.max(1, ring.length);
  return [x / n, y / n, z / n];
}
