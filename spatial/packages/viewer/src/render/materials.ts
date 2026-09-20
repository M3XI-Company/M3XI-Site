import * as THREE from 'three';
import type { DisplayClass } from '../provenance/classify.js';
import { DISPLAY_STYLE } from '../provenance/classify.js';

/**
 * THE HATCH
 * =========
 *
 * Provenance is drawn as a screen-space diagonal hatch rather than a colour,
 * for the reasons set out in `provenance/classify.ts`. Screen space matters:
 * a texture-space hatch shrinks with distance until it disappears exactly when
 * the visitor steps back to look at a whole room, which is when they most need
 * to see it. At a fixed pixel pitch the mark reads the same from anywhere.
 *
 * The hatch colour is the theme's ink, not a hue of its own, so it composites
 * as a drafting mark over both a bright kitchen and a dark hallway.
 *
 * `polygonOffset` is doing real work here. The proxy mesh is coincident with
 * the splat surface it describes, and without an offset the two z-fight into a
 * shimmering mess at every wall. Pulling the proxy a hair towards the camera
 * is the standard decal fix and costs nothing.
 */

export interface ThemeColours {
  /** Text and hatch colour. */
  readonly ink: THREE.Color;
  /** Background behind the property when no splat covers it. */
  readonly paper: THREE.Color;
  readonly accent: THREE.Color;
}

export const LIGHT_THEME: ThemeColours = {
  ink: new THREE.Color('#1a1d20'),
  paper: new THREE.Color('#e9e6e1'),
  accent: new THREE.Color('#8a6a3b'),
};

export const DARK_THEME: ThemeColours = {
  ink: new THREE.Color('#e8e6e2'),
  paper: new THREE.Color('#131517'),
  accent: new THREE.Color('#c9a468'),
};

const HATCH_VERT = /* glsl */`
varying vec3 vNormalW;
varying vec3 vPosW;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vPosW = world.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * `uShell` blends between two jobs for one material:
 *   0 -- a transparent hatch laid over a photoreal splat;
 *   1 -- a matte shaded surface for a world with no splat yet, which an
 *        operator reviews as geometry rather than as a photograph.
 */
const HATCH_FRAG = /* glsl */`
precision highp float;
uniform vec3 uInk;
uniform vec3 uPaper;
uniform float uPitch;
uniform float uAlpha;
uniform float uShell;
uniform float uPixelRatio;
varying vec3 vNormalW;
varying vec3 vPosW;

void main() {
  // Matte shading for the shell.
  //
  // The proxy is double-sided, so a triangle's own normal may point either
  // way depending on how the ring that generated it was wound. Flipping the
  // normal to face the viewer makes the shading winding-independent, which is
  // what stops one wall of a room reading as lit and its neighbour as dark for
  // no reason a person could name.
  //
  // The tone then comes from where the surface faces, not from a light rig:
  // floors bright, walls mid, ceilings dark. That is how an architectural
  // drawing reads a room, and it is legible in both themes because both ends
  // of the ramp are mixed from the theme's own paper and ink.
  vec3 n = normalize(vNormalW);
  vec3 toEye = normalize(cameraPosition - vPosW);
  if (dot(n, toEye) < 0.0) n = -n;

  float up = n.y * 0.5 + 0.5;                                  // 1 floor, 0 ceiling
  float key = clamp(dot(n, normalize(vec3(0.42, 0.78, 0.46))), 0.0, 1.0);
  float tone = clamp(0.18 + 0.46 * up + 0.34 * key, 0.0, 1.0);

  vec3 shellDark = mix(uPaper, uInk, 0.58);
  vec3 shellLight = mix(uPaper, uInk, 0.05);
  vec3 shell = mix(shellDark, shellLight, tone);

  float alpha = uAlpha;
  vec3 colour = mix(uInk, shell, uShell);

  if (uPitch > 0.0) {
    // Diagonal stripes at a fixed device-independent pitch.
    float pitch = uPitch * uPixelRatio;
    float d = (gl_FragCoord.x + gl_FragCoord.y) / pitch;
    float tri = abs(fract(d) - 0.5) * 2.0;
    // fwidth keeps the line one pixel wide at any pitch instead of aliasing
    // into moire when the surface is nearly edge-on.
    float w = max(fwidth(d) * 2.0, 0.08);
    float line = 1.0 - smoothstep(0.5 - w, 0.5 + w, tri);
    if (uShell > 0.5) {
      colour = mix(colour, uInk, line * uAlpha);
    } else {
      alpha = line * uAlpha;
      colour = uInk;
    }
  }

  if (alpha < 0.004) discard;
  gl_FragColor = vec4(colour, alpha);
}
`;

export interface SurfaceMaterialOptions {
  readonly displayClass: DisplayClass;
  readonly theme: ThemeColours;
  /** True when no splat exists: draw the proxy as a shaded shell. */
  readonly shell: boolean;
  readonly pixelRatio: number;
}

export function createSurfaceMaterial(opts: SurfaceMaterialOptions): THREE.ShaderMaterial {
  const style = DISPLAY_STYLE[opts.displayClass];
  const shell = opts.shell ? 1 : 0;
  const material = new THREE.ShaderMaterial({
    vertexShader: HATCH_VERT,
    fragmentShader: HATCH_FRAG,
    transparent: !opts.shell,
    depthWrite: opts.shell,
    depthTest: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
    uniforms: {
      uInk: { value: opts.theme.ink.clone() },
      uPaper: { value: opts.theme.paper.clone() },
      uPitch: { value: style.hatchPitch },
      uAlpha: { value: opts.shell ? Math.max(style.hatchAlpha, 0.35) : style.hatchAlpha },
      uShell: { value: shell },
      uPixelRatio: { value: opts.pixelRatio },
    },
  });
  material.name = `m3xi-surface-${opts.displayClass}${opts.shell ? '-shell' : ''}`;
  return material;
}

/** Hairline boundary where unsurveyed geometry meets the real property. */
export function createBoundaryMaterial(theme: ThemeColours): THREE.LineBasicMaterial {
  const m = new THREE.LineBasicMaterial({
    color: theme.ink.clone(),
    transparent: true,
    opacity: 0.55,
    depthTest: true,
  });
  m.name = 'm3xi-boundary';
  return m;
}

/**
 * Measurement geometry. Drawn with `depthTest: false` on purpose: a tape
 * measure you cannot see because a sofa is in the way is not a tape measure.
 * The label carries the same information in the DOM, so the 3D line is a
 * pointer rather than the source of truth.
 */
export function createMeasureLineMaterial(
  theme: ThemeColours, status: 'defensible' | 'indicative',
): THREE.LineBasicMaterial {
  const m = new THREE.LineBasicMaterial({
    color: status === 'defensible' ? theme.accent.clone() : theme.ink.clone(),
    transparent: true,
    opacity: status === 'defensible' ? 0.95 : 0.6,
    depthTest: false,
  });
  m.name = `m3xi-measure-${status}`;
  return m;
}

export function createMeasureFillMaterial(theme: ThemeColours): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    color: theme.accent.clone(),
    transparent: true,
    opacity: 0.14,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  m.name = 'm3xi-measure-fill';
  return m;
}

/**
 * Entity highlight. An outline, not a tint: tinting a sofa changes what the
 * customer thinks the sofa looks like, which is the one thing a photoreal
 * viewer must never do.
 */
export function createHighlightMaterial(theme: ThemeColours): THREE.LineBasicMaterial {
  const m = new THREE.LineBasicMaterial({
    color: theme.accent.clone(),
    transparent: true,
    opacity: 0.9,
    depthTest: false,
  });
  m.name = 'm3xi-highlight';
  return m;
}

export function themeFor(dark: boolean): ThemeColours {
  return dark ? DARK_THEME : LIGHT_THEME;
}

export function applyTheme(material: THREE.ShaderMaterial, theme: ThemeColours): void {
  const ink = material.uniforms['uInk']?.value as THREE.Color | undefined;
  const paper = material.uniforms['uPaper']?.value as THREE.Color | undefined;
  ink?.copy(theme.ink);
  paper?.copy(theme.paper);
}
