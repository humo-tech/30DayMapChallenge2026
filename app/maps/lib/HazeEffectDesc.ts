// A plain haze for Navara: the further away the ground, the more it fades into the sky's color at
// the horizon (1 - exp(-distance / reach)). A light stand-in for the built-in aerial perspective,
// which loads ~10 MB of precomputed scattering textures. The distance comes from the view's depth
// (Navara writes a logarithmic depth buffer); the sky, at the far plane, is left as it is.
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
import { Color, RGBADepthPacking, Uniform, type Camera, type PerspectiveCamera, type Texture } from 'three'

const fragmentShader = /* glsl */ `
  uniform sampler2D uDepth;
  uniform float uLogFar;
  uniform float uReach;
  uniform float uMax;
  uniform vec3 uColor;

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    #if DEPTH_PACKING == 3201
      float d = unpackRGBAToDepth(texture2D(uDepth, uv));
    #else
      float d = texture2D(uDepth, uv).r;
    #endif
    if (d >= 0.99999) {
      outputColor = inputColor;
      return;
    }
    // Three's logarithmic depth: d = log2(1 + w) / log2(far + 1), w the view distance
    float distance = exp2(d * uLogFar) - 1.0;
    float f = uMax * (1.0 - exp(-distance / uReach));
    outputColor = vec4(mix(inputColor.rgb, uColor, f), inputColor.a);
  }
`

class HazeEffect extends Effect {
  constructor(depth: Texture, packing: number) {
    super('HazeEffect', fragmentShader, {
      defines: new Map([['DEPTH_PACKING', String(packing)]]),
      uniforms: new Map<string, Uniform>([
        ['uDepth', new Uniform(depth)],
        ['uLogFar', new Uniform(1)],
        ['uReach', new Uniform(50_000)],
        ['uMax', new Uniform(0.7)],
        ['uColor', new Uniform(new Color(1, 1, 1))],
      ]),
    })
  }
}

export type HazeOptions = EffectOptions
class Haze extends NavaraEffect<HazeEffect, HazeOptions> {
  constructor(
    private readonly cam: Camera,
    depth: Texture,
    packing: number,
    options?: HazeOptions,
  ) {
    super(cam, new HazeEffect(depth, packing), options)
  }

  /** Follows the camera's far plane, which Navara moves with the camera's height */
  tick(): void {
    this.rawEffect.uniforms.get('uLogFar')!.value = Math.log2((this.cam as PerspectiveCamera).far + 1)
  }

  set(color: Color, reach: number, max: number): void {
    ;(this.rawEffect.uniforms.get('uColor')!.value as Color).copy(color)
    this.rawEffect.uniforms.get('uReach')!.value = reach
    this.rawEffect.uniforms.get('uMax')!.value = max
  }
}

type Description = { haze?: Record<string, never> }
export type HazeConfig = EffectConfig & Description
type HazeUpdate = EffectUpdate & Description

export class HazeEffectDesc extends EffectDesc<HazeConfig, HazeUpdate, Haze> {
  static override key = 'haze'
  static override insertAfter = ['mrt']
  // Before the transparent pass, whose overlays write no depth
  static override insertBefore = ['transparent', 'smaa', 'fxaa', 'final']

  private config: HazeConfig

  constructor(view: ThreeView, ctx: ViewContext, config: HazeConfig) {
    super(view, ctx, config)
    this.config = config
  }

  override createPass() {
    const mrt = this.find<MRTPassEffectDesc>('mrt')
    if (!mrt?.depthBuffer) throw new Error('Haze: the MRT pass is not ready')
    return new Haze(this.view.camera.raw, mrt.depthBuffer, mrt.depthBufferPacking ?? RGBADepthPacking, {
      enabled: this.config.visible ?? true,
    })
  }

  override update(): void {
    this._instance?.tick()
  }

  /** The haze's color (linear), the distance (m) it builds up over, and the most it ever covers (0-1) */
  setHaze(color: Color, reach: number, max: number): void {
    this._instance?.set(color, reach, max)
  }
}
