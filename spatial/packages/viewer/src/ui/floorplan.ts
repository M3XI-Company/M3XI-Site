import type { Vec3 } from '@m3xi/world-core';
import type { World } from '@m3xi/spatial-engine';
import { classifyRoom } from '../provenance/classify.js';
import { formatQuantity, type FormatOptions } from '../measure/format.js';
import { clear, svg } from './dom.js';

/**
 * The floorplan is drawn from the same room polygons the engine measures, so
 * it cannot drift from the 3D view or from the numbers. It is an SVG rather
 * than a canvas because every room needs to be a focusable, labelled control:
 * a keyboard user tabs the plan and hears "Kitchen/diner, 19.2 square metres,
 * plus or minus 2.5 per cent" before deciding where to go.
 *
 * Unsurveyed volumes are hatched here too, with the same 45-degree mark used
 * in the 3D view, so the two representations teach the same vocabulary.
 */

export interface FloorplanOptions extends FormatOptions {
  readonly onSelectRoom: (roomId: string) => void;
}

export class Floorplan {
  readonly node: SVGElement;
  private readonly roomNodes = new Map<string, SVGElement>();
  private readonly you: SVGElement;
  private bounds = { minX: 0, minZ: 0, maxX: 1, maxZ: 1 };

  constructor(
    private readonly world: World,
    private readonly opts: FloorplanOptions,
  ) {
    this.node = svg('svg', {
      class: 'm3xi-plan',
      role: 'group',
      'aria-label': 'Floorplan',
      preserveAspectRatio: 'xMidYMid meet',
    });
    this.you = svg('circle', { class: 'you', r: '0.22', cx: '0', cy: '0' });
    this.build();
  }

  private build(): void {
    clear(this.node);
    const rooms = this.world.doc.rooms;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const r of rooms) {
      for (const v of r.polygon) {
        minX = Math.min(minX, v[0]); maxX = Math.max(maxX, v[0]);
        minZ = Math.min(minZ, v[1]); maxZ = Math.max(maxZ, v[1]);
      }
    }
    if (!Number.isFinite(minX)) { minX = 0; minZ = 0; maxX = 1; maxZ = 1; }
    const pad = 0.4;
    this.bounds = { minX: minX - pad, minZ: minZ - pad, maxX: maxX + pad, maxZ: maxZ + pad };
    const w = this.bounds.maxX - this.bounds.minX;
    const h = this.bounds.maxZ - this.bounds.minZ;
    this.node.setAttribute('viewBox', `${this.bounds.minX} ${this.bounds.minZ} ${w} ${h}`);

    const defs = svg('defs', {}, [
      svg('pattern', {
        id: 'm3xi-hatch', width: '0.3', height: '0.3',
        patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)',
      }, [
        svg('line', {
          x1: '0', y1: '0', x2: '0', y2: '0.3',
          stroke: 'currentColor', 'stroke-width': '0.05', 'stroke-opacity': '0.5',
        }),
      ]),
    ]);
    this.node.appendChild(defs);

    for (const room of rooms) {
      const points = room.polygon.map((v) => `${v[0]},${v[1]}`).join(' ');
      const area = this.world.measureArea(room.id);
      const f = formatQuantity(area, this.opts);
      const cls = classifyRoom(this.world, room.id);
      const name = room.name ?? room.id;
      const gapNote = cls.regions.length > 0
        ? `. ${cls.regions.length === 1 ? 'One area' : `${cls.regions.length} areas`} not fully surveyed`
        : '';

      const poly = svg('polygon', {
        class: 'room',
        points,
        tabindex: '0',
        role: 'button',
        'aria-label': `${name}. ${f.speech}${gapNote}. Go to this room.`,
      });
      poly.addEventListener('click', () => this.opts.onSelectRoom(room.id));
      poly.addEventListener('keydown', (e) => {
        const ev = e as KeyboardEvent;
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          this.opts.onSelectRoom(room.id);
        }
      });
      this.node.appendChild(poly);
      this.roomNodes.set(room.id, poly);

      const centre = centroid(room.polygon);
      this.node.appendChild(svg('text', {
        class: 'label', x: String(centre[0]), y: String(centre[1]), 'aria-hidden': 'true',
      }, [name]));
    }

    // Unsurveyed and estimated volumes, projected onto the plan.
    //
    // A plan is a floor-plane drawing, so a region that sits entirely above
    // head height -- a void over a ceiling -- must NOT be hatched across the
    // room's floor. Doing that made the whole hall read as unsurveyed when
    // only the space above its ceiling was, which is its own misstatement.
    // Those are drawn as a dashed outline instead: something is recorded here,
    // but not at the level this drawing describes.
    const STANDING_HEIGHT_M = 2.0;
    for (const region of this.world.doc.regions) {
      if (region.provenance === 'observed') continue;
      const v = region.volume;
      const w2 = v.max[0] - v.min[0];
      const h2 = v.max[2] - v.min[2];
      if (!(w2 > 0.02 && h2 > 0.02)) continue;
      const room = region.roomId ? this.world.room(region.roomId) : undefined;
      const floor = room?.floorZ ?? 0;
      const overhead = v.min[1] >= floor + STANDING_HEIGHT_M;
      this.node.appendChild(svg('rect', {
        class: overhead ? 'gap-above' : 'gap',
        x: String(v.min[0]), y: String(v.min[2]),
        width: String(w2), height: String(h2),
        'aria-hidden': 'true',
      }));
    }

    this.node.appendChild(this.you);
  }

  /** Move the "you are here" dot. Called from the render loop, so it is cheap. */
  setPosition(p: Vec3): void {
    this.you.setAttribute('cx', p[0].toFixed(3));
    this.you.setAttribute('cy', p[2].toFixed(3));
  }

  setCurrentRoom(roomId: string | undefined): void {
    for (const [id, node] of this.roomNodes) {
      if (id === roomId) node.setAttribute('aria-current', 'true');
      else node.removeAttribute('aria-current');
    }
  }

  emphasise(roomIds: readonly string[]): boolean {
    let any = false;
    const wanted = new Set(roomIds);
    for (const [id, node] of this.roomNodes) {
      if (wanted.has(id)) { node.setAttribute('aria-current', 'true'); any = true; }
      else node.removeAttribute('aria-current');
    }
    return any;
  }

  dispose(): void {
    clear(this.node);
    this.roomNodes.clear();
    this.node.remove();
  }
}

function centroid(ring: readonly (readonly [number, number])[]): [number, number] {
  if (ring.length === 0) return [0, 0];
  let x = 0, z = 0;
  for (const v of ring) { x += v[0]; z += v[1]; }
  return [x / ring.length, z / ring.length];
}
