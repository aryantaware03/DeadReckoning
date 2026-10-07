// GLSL sources for the navigation corridor.
//
// Kept apart from the component so they can be compiled in isolation — a
// shader typo is invisible to TypeScript and survives `vite build`, only
// showing up as a black canvas at runtime. check-shaders.mjs compiles every
// entry here against a real WebGL context.
//
// Shared conventions:
//   aStation  the 0..1 position along the corridor that a vertex belongs to
//   uNow      the viewer's 0..1 position, written once per frame
// Everything else animates from those two, which is why the render loop only
// ever touches a single uniform.

/** Position attribute plus the station varying. */
export const STATION_VERT = /* glsl */ `
  attribute float aStation;
  varying float vStation;
  void main() {
    vStation = aStation;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

/** The fade window every layer shares. */
export const WINDOW_HEAD = /* glsl */ `
  uniform float uNow;
  uniform float uBehind;
  uniform float uAhead;
  varying float vStation;
  float windowFade() {
    float d = vStation - uNow;
    if (d < -uBehind || d > uAhead) return 0.0;
    return clamp(d >= 0.0 ? 1.0 - d / uAhead : 1.0 + d / uBehind, 0.0, 1.0);
  }
`

/**
 * Trajectory shader.
 *
 * The point of interest: `vStation - uNow` splits one geometry into the part
 * already travelled and the part the model still estimates. History is solid
 * and dimmed, prediction is brighter and dashed with a phase that marches
 * forward. Both states come from the same recorded run, so no second path has
 * to exist or be invented.
 */
export const TRAJECTORY_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uDashPhase;
  ${WINDOW_HEAD}
  void main() {
    float fade = windowFade();
    if (fade <= 0.002) discard;

    float ahead = step(0.0, vStation - uNow);

    // Dashes march away from the viewer, so forward motion reads even when the
    // bike is holding a perfectly steady line.
    float d = fract(vStation * 260.0 - uDashPhase);
    float dash = mix(1.0, smoothstep(0.0, 0.10, d) * smoothstep(0.66, 0.56, d), ahead);

    float a = fade * uOpacity * dash * mix(0.62, 1.0, ahead);
    if (a <= 0.002) discard;
    gl_FragColor = vec4(uColor, a);
  }
`

/** Flat line: rings, grid, envelope walls. */
export const LINE_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform float uOpacity;
  ${WINDOW_HEAD}
  void main() {
    float fade = windowFade();
    if (fade <= 0.002) discard;
    gl_FragColor = vec4(uColor, fade * uOpacity);
  }
`

/**
 * The uncertainty fill. Half-width is the filter's own sigma, and the tint
 * drifts towards the uncorrected trajectory's colour as it opens up, so a wide
 * envelope is legible at a glance and not only by measuring it.
 */
export const ENVELOPE_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uTight;
  uniform vec3 uLoose;
  ${WINDOW_HEAD}
  varying float vSigma;
  void main() {
    float fade = windowFade();
    if (fade <= 0.002) discard;
    float t = clamp(vSigma / 4.2, 0.0, 1.0);
    gl_FragColor = vec4(mix(uTight, uLoose, t), fade * (0.07 + 0.13 * t));
  }
`

export const ENVELOPE_VERT = /* glsl */ `
  attribute float aStation;
  attribute float aSigma;
  varying float vStation;
  varying float vSigma;
  void main() {
    vStation = aStation;
    vSigma = aSigma;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

/** Distance gates. Every fifth is weighted, which is what makes distance countable. */
export const RING_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform vec3 uAccent;
  ${WINDOW_HEAD}
  varying float vMajor;
  void main() {
    float fade = windowFade();
    if (fade <= 0.002) discard;
    float major = step(0.5, vMajor);
    gl_FragColor = vec4(mix(uColor, uAccent, major), fade * mix(0.42, 0.85, major));
  }
`

export const RING_VERT = /* glsl */ `
  attribute float aStation;
  attribute float aMajor;
  varying float vStation;
  varying float vMajor;
  void main() {
    vStation = aStation;
    vMajor = aMajor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

/** Waypoint stations. Slow pulse, so a node announces itself without strobing. */
export const NODE_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uPortal;
  uniform vec3 uSlip;
  uniform float uTime;
  ${WINDOW_HEAD}
  varying float vKind;
  void main() {
    float fade = windowFade();
    if (fade <= 0.002) discard;
    float pulse = 0.8 + 0.2 * sin(uTime * 2.1 + vStation * 40.0);
    gl_FragColor = vec4(mix(uSlip, uPortal, step(vKind, 1.5)), fade * pulse);
  }
`

export const NODE_VERT = /* glsl */ `
  attribute float aStation;
  attribute float aKind;
  varying float vStation;
  varying float vKind;
  void main() {
    vStation = aStation;
    vKind = aKind;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

/**
 * Dust. Positions never change; the camera's own motion parallaxes them, which
 * costs nothing and reads better than animating the motes. The alpha window is
 * what keeps them inside the visible stretch of corridor.
 */
export const DUST_VERT = /* glsl */ `
  attribute float aStation;
  uniform float uNow;
  uniform float uPixelRatio;
  varying float vAlpha;
  void main() {
    float rel = aStation - uNow;
    vAlpha = smoothstep(-0.02, 0.02, rel) * (1.0 - smoothstep(0.04, 0.15, rel));
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = (uPixelRatio * 26.0) / max(1.0, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`

export const DUST_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    if (vAlpha <= 0.004) discard;
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    gl_FragColor = vec4(uColor, vAlpha * (1.0 - r2 * 4.0) * 0.42);
  }
`

/**
 * Every shader pair the corridor uses, with the uniform names each one needs.
 * `check-shaders.mjs` walks this list and compiles each pair, so a new layer
 * that forgets to declare a uniform fails the check rather than the page.
 */
export const NAV_SHADERS: { name: string; vertex: string; fragment: string; uniforms: string[] }[] = [
  {
    name: 'trajectory',
    vertex: STATION_VERT,
    fragment: TRAJECTORY_FRAG,
    uniforms: ['uColor', 'uOpacity', 'uDashPhase', 'uNow', 'uBehind', 'uAhead'],
  },
  {
    name: 'line',
    vertex: STATION_VERT,
    fragment: LINE_FRAG,
    uniforms: ['uColor', 'uOpacity', 'uNow', 'uBehind', 'uAhead'],
  },
  {
    name: 'envelope',
    vertex: ENVELOPE_VERT,
    fragment: ENVELOPE_FRAG,
    uniforms: ['uTight', 'uLoose', 'uNow', 'uBehind', 'uAhead'],
  },
  {
    name: 'ring',
    vertex: RING_VERT,
    fragment: RING_FRAG,
    uniforms: ['uColor', 'uAccent', 'uNow', 'uBehind', 'uAhead'],
  },
  {
    name: 'node',
    vertex: NODE_VERT,
    fragment: NODE_FRAG,
    uniforms: ['uPortal', 'uSlip', 'uTime', 'uNow', 'uBehind', 'uAhead'],
  },
  {
    name: 'dust',
    vertex: DUST_VERT,
    fragment: DUST_FRAG,
    uniforms: ['uColor', 'uNow', 'uPixelRatio'],
  },
]