// The world seen through water, for Navara: a full-screen post effect that pushes the picture
// about like the surface of a pond (slow ripples running over it), splits its colours at the
// edges and, as the world falls over, swirls it round the middle. The panels of the page are
// DOM, above the canvas, and stay as they are.
//
// `setWarp(wobble, fall)`: how much it ripples all the time (0-1) and how far the world is
// falling (0-1: stronger ripples, a swirl, a pinch at the middle, colours coming apart).
import {
  Effect as NavaraEffect,
  EffectDesc,
  type EffectConfig,
  type EffectOptions,
  type EffectUpdate,
  type ViewContext,
} from '@navaramap/three'
import type ThreeView from '@navaramap/three'
import { Effect } from 'postprocessing'
import type { Camera, WebGLRenderer, WebGLRenderTarget } from 'three'
import { Uniform } from 'three'

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uWobble;
  uniform float uFall;
  uniform float uAspect;

  // The picture's own point of view moved about: ripples, then a swirl and pinch round the middle
  void mainUv(inout vec2 uv) {
    float t = uTime;
    vec2 p = uv;
    // Two ripples crossing, each bending the other
    float w = 0.011 * uWobble + 0.02 * uFall;
    uv += w * vec2(
      sin(p.y * 9.0 + t * 0.8 + 1.7 * sin(p.x * 4.0 - t * 0.45)),
      cos(p.x * 8.0 - t * 0.7 + 1.5 * sin(p.y * 5.0 + t * 0.35))
    );
    // Finer, quicker ones on top
    uv += 0.35 * w * vec2(sin(p.y * 31.0 - t * 1.9), cos(p.x * 27.0 + t * 1.6));

    // Round the middle, as the world turns over: a swirl that tightens in, and a pinch
    vec2 c = uv - 0.5;
    c.x *= uAspect;
    float r = length(c);
    float swirl = uFall * 1.6 * exp(-r * r * 6.0) * sin(t * 0.6 + 0.8);
    float s = sin(swirl), co = cos(swirl);
    c = mat2(co, -s, s, co) * c;
    c *= 1.0 - uFall * 0.22 * exp(-r * r * 9.0);
    c.x /= uAspect;
    // A touch of zoom keeps the pushed edge inside the picture
    uv = 0.5 + c * (1.0 - 0.02 * uWobble - 0.05 * uFall);
  }

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    // Colours drift apart towards the edge, and more when falling
    vec2 d = (uv - 0.5) * (0.0015 * uWobble + 0.012 * uFall);
    float r = texture2D(inputBuffer, uv + d).r;
    float b = texture2D(inputBuffer, uv - d).b;
    outputColor = vec4(r, inputColor.g, b, inputColor.a);
  }
`

class WarpEffect extends Effect {
  constructor() {
    super('WarpEffect', fragmentShader, {
      uniforms: new Map<string, Uniform>([
        ['uTime', new Uniform(0)],
        ['uWobble', new Uniform(1)],
        ['uFall', new Uniform(0)],
        ['uAspect', new Uniform(1)],
      ]),
    })
  }

  override update(_renderer: WebGLRenderer, _inputBuffer: WebGLRenderTarget, deltaTime: number): void {
    this.uniforms.get('uTime')!.value += deltaTime
  }

  override setSize(width: number, height: number): void {
    super.setSize(width, height)
    this.uniforms.get('uAspect')!.value = width / Math.max(height, 1)
  }
}

export type WarpOptions = EffectOptions
class Warp extends NavaraEffect<WarpEffect, WarpOptions> {
  constructor(camera: Camera, options?: WarpOptions) {
    super(camera, new WarpEffect(), options)
  }

  setWarp(wobble: number, fall: number): void {
    this.rawEffect.uniforms.get('uWobble')!.value = wobble
    this.rawEffect.uniforms.get('uFall')!.value = fall
  }
}

type Description = { warp?: Record<string, never> }
export type WarpConfig = EffectConfig & Description
type WarpUpdate = EffectUpdate & Description

export class WarpEffectDesc extends EffectDesc<WarpConfig, WarpUpdate, Warp> {
  static override key = 'warp'
  static override insertBefore = ['smaa', 'fxaa', 'final']

  private config: WarpConfig

  constructor(view: ThreeView, ctx: ViewContext, config: WarpConfig) {
    super(view, ctx, config)
    this.config = config
  }

  override createPass() {
    return new Warp(this.view.camera.raw, { enabled: this.config.visible ?? true })
  }

  /** How much the picture ripples all the time, and how far the world is falling (each 0-1). */
  setWarp(wobble: number, fall: number): void {
    this._instance?.setWarp(wobble, fall)
  }
}
