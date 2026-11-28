// Day 28's palette, laid on after the map is drawn. Re-colouring the layers themselves is slow
// (draped polygons are baked into the globe's textures, so every change re-bakes them), so the
// map is drawn once, flat and unlit, in key colours — a hue for each part, at full or half
// strength — and this pass reads each pixel's part off its key and paints it in the palette of
// the moment. Space is where the depth is at the far plane. Any number of palette changes a frame
// cost one full-screen pass.
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
import { Color, RGBADepthPacking, Uniform, type Camera, type Texture } from 'three'
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
  ${ROLES.map((r) => `uniform vec3 ${uniform(r)};`).join('\n  ')}

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    #if DEPTH_PACKING == 3201
      float d = unpackRGBAToDepth(texture2D(uDepth, uv));
    #else
      float d = texture2D(uDepth, uv).r;
    #endif
    if (d >= 0.99999) {
      outputColor = vec4(u_sky, inputColor.a);
      return;
    }
    vec3 c = inputColor.rgb;
    float hi = max(c.r, max(c.g, c.b));
    float lo = min(c.r, min(c.g, c.b));
    float sat = hi > 1e-4 ? (hi - lo) / hi : 0.0;
    // Half keys are 0x80: 0.22 in linear light
    bool dim = hi < 0.5;
    vec3 col;
    if (sat < 0.4) {
      col = dim ? u_grid : u_ocean;
    } else {
      // Hue in sixths: 0 red, 1 yellow, 2 green, 3 cyan, 4 blue, 5 magenta
      float span = hi - lo;
      float h;
      if (hi == c.r) h = mod((c.g - c.b) / span, 6.0);
      else if (hi == c.g) h = (c.b - c.r) / span + 2.0;
      else h = (c.r - c.g) / span + 4.0;
      int k = int(mod(floor(h + 0.5), 6.0));
      col = k == 0 ? (dim ? u_city : u_landA)
          : k == 1 ? u_landB
          : k == 2 ? u_landC
          : k == 3 ? u_landD
          : k == 4 ? (dim ? u_ice : u_water)
          : u_border;
    }
    outputColor = vec4(col, inputColor.a);
  }
`

class MoodRecolorEffect extends Effect {
  constructor(depth: Texture, packing: number) {
    super('MoodRecolorEffect', fragmentShader, {
      defines: new Map([['DEPTH_PACKING', String(packing)]]),
      uniforms: new Map<string, Uniform>([['uDepth', new Uniform(depth)], ...ROLES.map((r) => [uniform(r), new Uniform(new Color())] as [string, Uniform])]),
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
}
