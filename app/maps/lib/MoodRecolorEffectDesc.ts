// Day 28's palette, laid on after the map is drawn. Re-colouring the layers themselves is slow
// (draped polygons are baked into the globe's textures, so every change re-bakes them), so the
// map is drawn once, flat and unlit, in key colours — a hue for each part, at full or half
// strength — and this pass reads each pixel's part off its key and paints it in the palette of
// the moment. Space is where the depth is at the far plane; there the pass also draws the air's
// glow round the globe (its centre and size on screen come from the page) and, for the sleepy,
// stars. The cities show only at night, as lights: otherwise each takes the colour of the ground
// round it. Any number of palette changes a frame cost one full-screen pass.
import {
  Effect as NavaraEffect,
  EffectDesc,
  type EffectConfig,
  type EffectOptions,
  type EffectUpdate,
  type MRTPassEffectDesc,
  type ViewContext,
} from '@navaramap/three'
import type ThreeView from '@navaramap/three'
import { Effect } from 'postprocessing'
import { Color, RGBADepthPacking, Uniform, Vector2, type Camera, type Texture } from 'three'
import { ROLES, type Role } from './moodPalette'

/** The key colours the parts are drawn in (sRGB; full keys are 1, half keys 0x80) */
export const KEYS = {
  ocean: '#ffffff',
  grid: '#808080',
  landA: '#ff0000',
  landB: '#ffff00',
  landC: '#00ff00',
  landD: '#00ffff',
  ice: '#000080',
  water: '#0000ff',
  border: '#ff00ff',
  city: '#800000',
} as const satisfies Partial<Record<Role, string>>

const uniform = (r: Role) => `u_${r}`

const fragmentShader = /* glsl */ `
  uniform sampler2D uDepth;
  // The globe on screen (uv, its radius in uv heights), the screen's width over height
  uniform vec2 uCenter;
  uniform float uRadius;
  uniform float uAspect;
  // How strong the glow is, how many stars show, how much the cities show (lit, 0-1), the time (s)
  uniform float uGlow;
  uniform float uStars;
  uniform float uCities;
  uniform float uTime;
  ${ROLES.map((r) => `uniform vec3 ${uniform(r)};`).join('\n  ')}

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  // A key colour's part: 0 ocean, 1 grid, 2-5 the land's shades, 6 ice, 7 water, 8 border, 9 city
  int part(vec3 c) {
    float hi = max(c.r, max(c.g, c.b));
    float lo = min(c.r, min(c.g, c.b));
    float sat = hi > 1e-4 ? (hi - lo) / hi : 0.0;
    // Half keys are 0x80: 0.22 in linear light
    bool dim = hi < 0.5;
    if (sat < 0.4) return dim ? 1 : 0;
    // Hue in sixths: 0 red, 1 yellow, 2 green, 3 cyan, 4 blue, 5 magenta
    float span = hi - lo;
    float h;
    if (hi == c.r) h = mod((c.g - c.b) / span, 6.0);
    else if (hi == c.g) h = (c.b - c.r) / span + 2.0;
    else h = (c.r - c.g) / span + 4.0;
    int k = int(mod(floor(h + 0.5), 6.0));
    // A city only where the key is clean (dim, pure red): where two parts' colours blend at an
    // edge, a red and something darker can come out dim red too
    bool city = dim && hi > 0.12 && hi < 0.35 && sat > 0.9 && abs(h - (h > 3.0 ? 6.0 : 0.0)) < 0.25;
    return k == 0 ? (city ? 9 : 2) : k == 1 ? 3 : k == 2 ? 4 : k == 3 ? 5 : k == 4 ? (dim ? 6 : 7) : 8;
  }

  vec3 paint(int p) {
    return p == 0 ? u_ocean : p == 1 ? u_grid : p == 2 ? u_landA : p == 3 ? u_landB : p == 4 ? u_landC
         : p == 5 ? u_landD : p == 6 ? u_ice : p == 7 ? u_water : p == 8 ? u_border : u_city;
  }

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    #if DEPTH_PACKING == 3201
      float d = unpackRGBAToDepth(texture2D(uDepth, uv));
    #else
      float d = texture2D(uDepth, uv).r;
    #endif
    vec2 q = (uv - uCenter) * vec2(uAspect, 1.0);
    float r = length(q);
    if (d >= 0.99999) {
      // Space: the air's glow fading off the limb, and stars
      float off = max(0.0, r - uRadius) / uRadius;
      vec3 col = mix(u_sky, u_glow, clamp(uGlow * (exp(-off * 9.0) + 0.25 * exp(-off * 2.5)), 0.0, 1.0));
      vec2 cell = floor(uv * resolution / 3.0);
      float star = step(0.993, hash(cell));
      float twinkle = 0.55 + 0.45 * sin(uTime * (1.5 + 3.0 * hash(cell + 7.0)) + hash(cell + 3.0) * 6.28);
      col += vec3(1.0, 0.97, 0.9) * star * twinkle * uStars * smoothstep(0.0, 0.1, off);
      outputColor = vec4(col, inputColor.a);
      return;
    }
    int p = part(inputColor.rgb);
    vec3 col;
    vec2 px = 1.0 / resolution;
    if (p == 9) {
      // A city: lit, or (when the cities are out) the ground round it, read a few pixels off
      int under = part(texture2D(inputBuffer, uv + vec2(7.0, 0.0) * px).rgb);
      if (under == 9) under = part(texture2D(inputBuffer, uv - vec2(7.0, 0.0) * px).rgb);
      if (under == 9) under = 0;
      col = mix(paint(under), u_city * 1.4, uCities);
    } else {
      col = paint(p);
      // The cities' light spilling round them
      if (uCities > 0.01) {
        float glow = 0.0;
        for (int i = 0; i < 8; i++) {
          float a = float(i) * 0.785398;
          for (int j = 1; j <= 2; j++) {
            float rad = float(j) * 3.5;
            if (part(texture2D(inputBuffer, uv + vec2(cos(a), sin(a)) * rad * px).rgb) == 9) glow += j == 1 ? 0.14 : 0.07;
          }
        }
        col += u_city * min(glow, 0.8) * uCities;
      }
    }
    // The air, seen edge on round the rim
    float rim = smoothstep(0.82, 1.0, r / uRadius);
    col = mix(col, u_glow, rim * rim * clamp(uGlow, 0.0, 1.0) * 0.6);
    outputColor = vec4(col, inputColor.a);
  }
`

class MoodRecolorEffect extends Effect {
  constructor(depth: Texture, packing: number) {
    super('MoodRecolorEffect', fragmentShader, {
      defines: new Map([['DEPTH_PACKING', String(packing)]]),
      uniforms: new Map<string, Uniform>([
        ['uDepth', new Uniform(depth)],
        ['uCenter', new Uniform(new Vector2(0.5, 0.5))],
        ['uRadius', new Uniform(0.4)],
        ['uAspect', new Uniform(1)],
        ['uGlow', new Uniform(0.5)],
        ['uStars', new Uniform(0)],
        ['uCities', new Uniform(0)],
        ['uTime', new Uniform(0)],
        ...ROLES.map((r) => [uniform(r), new Uniform(new Color())] as [string, Uniform]),
      ]),
    })
  }
}

class MoodRecolor extends NavaraEffect<MoodRecolorEffect, EffectOptions> {
  constructor(cam: Camera, depth: Texture, packing: number, options?: EffectOptions) {
    super(cam, new MoodRecolorEffect(depth, packing), options)
  }

  set(colors: Record<Role, Color>): void {
    for (const r of ROLES) (this.rawEffect.uniforms.get(uniform(r))!.value as Color).copy(colors[r])
  }

  setSky(cx: number, cy: number, radius: number, aspect: number, glow: number, stars: number, cities: number, time: number): void {
    const u = this.rawEffect.uniforms
    u.get('uCities')!.value = cities
    ;(u.get('uCenter')!.value as Vector2).set(cx, cy)
    u.get('uRadius')!.value = radius
    u.get('uAspect')!.value = aspect
    u.get('uGlow')!.value = glow
    u.get('uStars')!.value = stars
    u.get('uTime')!.value = time
  }
}

type Description = { moodRecolor?: Record<string, never> }
export type MoodRecolorConfig = EffectConfig & Description
type MoodRecolorUpdate = EffectUpdate & Description

export class MoodRecolorEffectDesc extends EffectDesc<MoodRecolorConfig, MoodRecolorUpdate, MoodRecolor> {
  static override key = 'moodRecolor'
  static override insertAfter = ['mrt']
  static override insertBefore = ['transparent', 'smaa', 'fxaa', 'final']

  private config: MoodRecolorConfig

  constructor(view: ThreeView, ctx: ViewContext, config: MoodRecolorConfig) {
    super(view, ctx, config)
    this.config = config
  }

  override createPass() {
    const mrt = this.find<MRTPassEffectDesc>('mrt')
    if (!mrt?.depthBuffer) throw new Error('MoodRecolor: the MRT pass is not ready')
    return new MoodRecolor(this.view.camera.raw, mrt.depthBuffer, mrt.depthBufferPacking ?? RGBADepthPacking, {
      enabled: this.config.visible ?? true,
    })
  }

  /** The palette now (three's colours, linear) */
  setPalette(colors: Record<Role, Color>): void {
    this._instance?.set(colors)
  }

  /**
   * The globe on screen (centre in uv, radius in uv heights), the screen's width over height, how
   * strong the air's glow is (0-1+), how many stars show (0-1), how much the cities show, lit
   * (0-1), and the time (s)
   */
  setSky(cx: number, cy: number, radius: number, aspect: number, glow: number, stars: number, cities: number, time: number): void {
    this._instance?.setSky(cx, cy, radius, aspect, glow, stars, cities, time)
  }
}
