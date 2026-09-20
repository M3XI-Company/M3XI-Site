import { el, replace, svgEl, uniqueId } from './dom.js';
import { sameSelection, type PlanModel, type PlanSelection } from './plan.js';

/**
 * THE PLAN, AS ELEMENTS
 * =====================
 *
 * This file renders `PlanModel` and attaches listeners. It decides nothing:
 * every string it draws was produced by `plan.ts`, which is why the plan can
 * be tested without a browser.
 *
 * ACCESSIBILITY IS THE DESIGN HERE, NOT A PASS OVER IT AFTERWARDS. A
 * floorplan is the hardest thing in this product to make operable without a
 * mouse, and it is the primary pick surface, so if it only works by clicking
 * then the editor only works for some operators.
 *
 * The mapping chosen is a LISTBOX. The plan is a set of objects of which
 * exactly one is selected, which is what a listbox is; `role="img"` with a
 * description would be honest about the picture and useless for the task, and
 * a pile of `role="button"` shapes would put twenty-five tab stops between the
 * operator and the panel below. So:
 *
 *   - the `<svg>` is `role="listbox"` with an accessible name;
 *   - every selectable shape is a `<g role="option">` carrying the full
 *     accessible name `plan.ts` built -- what it is, how big, to what
 *     standard, whether that figure is defensible;
 *   - roving tabindex: exactly one option is in the tab ring, and the arrow
 *     keys, Home and End move between them. That is the standard listbox
 *     pattern and it is what a screen-reader user's fingers already do;
 *   - selection follows focus, because selecting is the only action here and a
 *     separate Enter step would be ceremony.
 *
 * Every shape also carries an invisible hit area wider than its stroke, so a
 * 0.1 m door leaf is a target a hand can hit (2.5.8) rather than a hairline.
 */

export interface PlanViewOptions {
  onSelect(selection: PlanSelection): void;
}

export interface PlanViewHandle {
  readonly root: HTMLElement;
  update(model: PlanModel, selected: PlanSelection | null): void;
  destroy(): void;
}

export function mountPlan(opts: PlanViewOptions): PlanViewHandle {
  const hatchId = uniqueId('rv-hatch');
  const root = el('div', { class: 'rv-plan-wrap' });
  let options: { selection: PlanSelection; node: SVGElement }[] = [];
  let current: PlanSelection | null = null;

  const focusAt = (index: number): void => {
    const target = options[index];
    if (!target) return;
    for (const o of options) o.node.setAttribute('tabindex', '-1');
    target.node.setAttribute('tabindex', '0');
    (target.node as unknown as { focus?: () => void }).focus?.();
    opts.onSelect(target.selection);
  };

  const onKeyDown = (event: Event): void => {
    const key = (event as KeyboardEvent).key;
    if (options.length === 0) return;
    const at = options.findIndex((o) => sameSelection(o.selection, current));
    const from = at < 0 ? 0 : at;
    let next: number | null = null;
    if (key === 'ArrowDown' || key === 'ArrowRight') next = (from + 1) % options.length;
    else if (key === 'ArrowUp' || key === 'ArrowLeft') next = (from - 1 + options.length) % options.length;
    else if (key === 'Home') next = 0;
    else if (key === 'End') next = options.length - 1;
    if (next === null) return;
    event.preventDefault();
    focusAt(next);
  };

  const update = (model: PlanModel, selected: PlanSelection | null): void => {
    current = selected;
    options = [];

    if (model.unavailable) {
      // No plan and no silence. An empty rectangle and a property with no
      // outlines look identical on screen, and only one of them is a fault.
      replace(root, el('div', { class: 'rv-note rv-note--bad', role: 'alert' },
        el('strong', {}, 'No floorplan can be drawn'),
        el('span', {}, model.unavailable)));
      return;
    }

    const svg = svgEl('svg', {
      class: 'rv-plan',
      viewBox: model.viewBox,
      role: 'listbox',
      'aria-label': 'Floorplan. Select a room, a doorway or an object to correct it.',
      preserveAspectRatio: 'xMidYMid meet',
      onkeydown: onKeyDown,
    });

    svg.appendChild(svgEl('defs', {}, svgEl('pattern', {
      id: hatchId, width: 0.3, height: 0.3, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)',
    }, svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 0.3, stroke: 'currentColor', 'stroke-width': 0.05, opacity: 0.45 }))));

    // Coverage notes go underneath everything: they are a statement about the
    // volume, not an object in it, and they must never obscure what they
    // qualify.
    for (const region of model.regions) {
      svg.appendChild(svgEl('rect', {
        x: region.x, y: region.y, width: region.width, height: region.height,
        class: 'rv-region',
        style: `fill:url(#${hatchId})`,
      }, svgEl('title', {}, region.ariaLabel)));
    }

    for (const room of model.rooms) {
      const shape = svgEl('polygon', { points: room.points, class: 'rv-room-fill' });
      const hit = svgEl('polygon', { points: room.points, class: 'rv-hit' });
      const ring = svgEl('polygon', { points: room.points, class: 'rv-focus-ring' });
      const group = option({ type: 'room', id: room.id }, room.ariaLabel, [
        shape, ring, hit,
        svgEl('text', {
          x: room.labelX, y: room.labelY, class: 'rv-room-label', 'text-anchor': 'middle',
        }, room.label),
        svgEl('text', {
          x: room.labelX, y: room.labelY + 0.3, class: 'rv-room-sub', 'text-anchor': 'middle',
        }, room.sub),
      ]);
      svg.appendChild(group);
    }

    for (const opening of model.openings) {
      const line = svgEl('line', {
        x1: opening.x1, y1: opening.y1, x2: opening.x2, y2: opening.y2,
        class: `rv-opening${opening.window ? ' rv-opening--window' : ''}`,
      });
      const hit = svgEl('line', {
        x1: opening.x1, y1: opening.y1, x2: opening.x2, y2: opening.y2, class: 'rv-hit',
      });
      const ring = svgEl('line', {
        x1: opening.x1, y1: opening.y1, x2: opening.x2, y2: opening.y2, class: 'rv-focus-ring',
      });
      svg.appendChild(option({ type: 'opening', id: opening.id }, opening.ariaLabel, [line, ring, hit]));
    }

    for (const entity of model.entities) {
      const rect = svgEl('rect', {
        x: entity.x, y: entity.y, width: entity.width, height: entity.height, class: 'rv-entity',
      });
      const ring = svgEl('rect', {
        x: entity.x, y: entity.y, width: entity.width, height: entity.height, class: 'rv-focus-ring',
      });
      const hit = svgEl('rect', {
        x: entity.x, y: entity.y, width: entity.width, height: entity.height, class: 'rv-hit',
      });
      svg.appendChild(option({ type: 'entity', id: entity.id }, entity.ariaLabel, [rect, ring, hit]));
    }

    replace(root, svg);

    // Exactly one option in the tab ring: the selected one, or the first.
    const selectedIndex = options.findIndex((o) => sameSelection(o.selection, selected));
    const ringIndex = selectedIndex >= 0 ? selectedIndex : 0;
    options.forEach((o, i) => o.node.setAttribute('tabindex', i === ringIndex ? '0' : '-1'));

    function option(selection: PlanSelection, ariaLabel: string, children: SVGElement[]): SVGElement {
      const isSelected = sameSelection(selection, selected);
      const group = svgEl('g', {
        role: 'option',
        'aria-label': ariaLabel,
        'aria-selected': isSelected ? 'true' : 'false',
        tabindex: '-1',
        onclick: () => opts.onSelect(selection),
        onfocus: () => { current = selection; },
      }, ...children, svgEl('title', {}, ariaLabel));
      options.push({ selection, node: group });
      return group;
    }
  };

  return {
    root,
    update,
    destroy: () => { replace(root); options = []; },
  };
}
