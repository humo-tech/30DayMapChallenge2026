// Eye-Dome Lighting for Navara: the shading point cloud viewers (Potree, CloudCompare) use to
// make points read as shapes. Each pixel is darkened by how far it stands out in front of its
// neighbours, in log depth, so edges, steps and the outlines against the sky come out dark
// with no normals or lights at all. Steps under `threshold` are let through: the points here are
// drawn as overlapping discs, and the small steps between them would speckle the whole surface.
// Works on the whole frame, so it fades in only for the points (`setStrength`).
import { Effect as NavaraEffect, EffectDesc, type EffectConfig, type EffectUpdate } from '@navaramap/three'
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'
import { Uniform, type Camera } from 'three'

const fragmentShader = /* glsl */ `
  uniform float uStrength;
  uniform float uRadius;
  uniform float uThreshold;
  uniform float uLogFar;

  // Navara writes a logarithmic depth: depth = log2(1 + w) / log2(far + 1), so this is ~log2(w)
  float logDistance(float depth) {
    return depth * uLogFar;
  }

  void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
    if (uStrength <= 0.0 || depth >= 0.99999) {
      outputColor = inputColor;
      return;
    }
    float centre = logDistance(depth);
    float response = 0.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7853982;
      float d = readDepth(uv + vec2(cos(a), sin(a)) * uRadius * texelSize);
      // Against the sky counts as a deep step, outlining the points' silhouette
      response += d >= 0.99999 ? 1.0 : max(0.0, centre - logDistance(d) - uThreshold);
    }
    // Far off (the sea of clouds' rim against the sky), no outlines
    response *= 1.0 - smoothstep(12.0, 14.0, centre);
    float shade = exp(-response / 8.0 * 300.0 * uStrength);
    outputColor = vec4(inputColor.rgb * shade, inputColor.a);
  }
`

class EyeDomeLightingEffect extends Effect {
  constructor() {
    super('EyeDomeLightingEffect', fragmentShader, {
      blendFunction: BlendFunction.NORMAL,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, Uniform>([
        ['uStrength', new Uniform(0)],
        ['uRadius', new Uniform(1.4)],
        ['uThreshold', new Uniform(0.006)],
        ['uLogFar', new Uniform(1)],
      ]),
    })
  }
}

class EyeDomeLighting extends NavaraEffect<EyeDomeLightingEffect> {
  constructor(camera: Camera) {
    super(camera, new EyeDomeLightingEffect())
  }
}

type EyeDomeLightingOptions = {
  /** Neighbour distance (px). Default: 1.4 */
  radius?: number
  /** Smallest step that shades, in log2 of the distance (0.006: ~0.4%). Default: 0.006 */
  threshold?: number
}
type Description = { eyeDomeLighting?: EyeDomeLightingOptions }
export type EyeDomeLightingConfig = EffectConfig & Description
type EyeDomeLightingUpdate = EffectUpdate & Description

export class EyeDomeLightingEffectDesc extends EffectDesc<EyeDomeLightingConfig, EyeDomeLightingUpdate, EyeDomeLighting> {
  static override key = 'eyeDomeLighting'
  static override insertAfter = ['mrt']

  private config: EyeDomeLightingConfig
  private strength = 0

  constructor(...args: ConstructorParameters<typeof EffectDesc<EyeDomeLightingConfig, EyeDomeLightingUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  override createPass() {
    return new EyeDomeLighting(this.view.camera.raw)
  }

  /** Shading strength: 0 off, 1 Potree's default. */
  setStrength(strength: number): void {
    this.strength = strength
  }

  override update(): void {
    const effect = this.raw?.rawEffect
    if (!effect) return
    const camera = this.view.camera.raw as Camera & { far: number }
    effect.uniforms.get('uStrength')!.value = this.strength
    effect.uniforms.get('uRadius')!.value = this.config.eyeDomeLighting?.radius ?? 1.4
    effect.uniforms.get('uThreshold')!.value = this.config.eyeDomeLighting?.threshold ?? 0.006
    effect.uniforms.get('uLogFar')!.value = Math.log2(camera.far + 1)
  }
}
