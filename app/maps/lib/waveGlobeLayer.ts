// Day 12's looks at the world's ocean waves (waveSim.ts) on MapLibre GL JS's globe: a custom layer
// with a Three.js renderer on the map's own GL context (as Day 10's bears). Each frame, before the
// map draws (`prerender`), the look shown runs on over what's in view, into its own targets; then
// (`render`) it's shown on a shell over the sea, a lng/lat grid whose vertices MapLibre's own
// `projectTile()` puts on the globe (the shader prelude it hands custom layers), so it sits on the
// map exactly and its far side is clipped like the map's.
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl'
import {
  AdditiveBlending,
  BufferGeometry,
  Camera,
  DoubleSide,
  Float32BufferAttribute,
  Matrix4,
  Mesh,
  Scene,
  ShaderMaterial,
  Vector4,
  WebGLRenderer,
  type IUniform,
} from 'three'
import { VIEW_SAMPLES, type LngLatRad, type WaveSim } from './waveSim'

// Web Mercator's reach, which MapLibre's globe draws the map to
const MAX_LAT = 85.0511

// The vertices are Web Mercator (0-1 from 180°W and from the north edge), which projectTile()
// takes; vGeo is lng, lat as 0-1 from 180°W, 90°S, which the shell's fragment shaders read
const shellVertex = (shaderData: CustomRenderMethodInput['shaderData']) => /* glsl */ `
  ${shaderData.vertexShaderPrelude}
  ${shaderData.define}
  varying vec2 vGeo;
  void main() {
    vGeo = uv;
    gl_Position = projectTile(position.xy);
  }
`

// The looks work in linear color, and Navara encodes its frame for the screen (sRGB) at the end;
// MapLibre draws straight to the screen, so the shell does it itself
const shellFragment = (fragment: string) => /* glsl */ `
  ${fragment.replace('void main()', 'void shellMain()')}
  void main() {
    shellMain();
    gl_FragColor = linearToOutputTexel(gl_FragColor);
  }
`

/** A lng/lat grid, uniform in latitude to MAX_LAT, with Web Mercator positions */
function mercatorGrid(columns: number, rows: number): BufferGeometry {
  const position = new Float32Array((columns + 1) * (rows + 1) * 3)
  const uv = new Float32Array((columns + 1) * (rows + 1) * 2)
  for (let j = 0; j <= rows; j++) {
    const lat = (j / rows) * 2 * MAX_LAT - MAX_LAT
    const y = 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI)
    for (let i = 0; i <= columns; i++) {
      const k = j * (columns + 1) + i
      position.set([i / columns, y, 0], k * 3)
      uv.set([i / columns, (lat + 90) / 180], k * 2)
    }
  }
  const index: number[] = []
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const k = j * (columns + 1) + i
      index.push(k, k + 1, k + columns + 1, k + 1, k + columns + 2, k + columns + 1)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(position, 3))
  geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2))
  geometry.setIndex(index)
  return geometry
}

export type WaveGlobeLayer<Mode extends string> = CustomLayerInterface & {
  /** Shows `mode`'s look, from afresh */
  show(mode: Mode): void
  dispose(): void
}

/** A custom layer showing one of `looks` at a time (`show()`), `mode` to start with. */
export function waveGlobeLayer<Mode extends string>(looks: Record<Mode, WaveSim>, mode: Mode): WaveGlobeLayer<Mode> {
  let map: MapLibreMap | undefined
  let renderer: WebGLRenderer | undefined
  const geometry = mercatorGrid(720, 360)
  const shell = new Mesh(geometry)
  shell.frustumCulled = false
  const scene = new Scene().add(shell)
  // (positions come from projectTile(): the camera's matrices go unused)
  const camera = new Camera()

  // MapLibre's projection, as projectTile() reads it
  const projection: Record<string, IUniform> = {
    u_projection_matrix: { value: new Matrix4() },
    u_projection_fallback_matrix: { value: new Matrix4() },
    u_projection_tile_mercator_coords: { value: new Vector4() },
    u_projection_clipping_plane: { value: new Vector4() },
    u_projection_transition: { value: 1 },
  }
  // A material per look and per projection variant (globe, or mercator zoomed far in), as the
  // prelude differs between them
  const materials = new Map<string, ShaderMaterial>()
  const materialFor = (look: Mode, shaderData: CustomRenderMethodInput['shaderData']) => {
    const key = `${look}:${shaderData.variantName}`
    let m = materials.get(key)
    if (!m) {
      m = new ShaderMaterial({
        vertexShader: shellVertex(shaderData),
        fragmentShader: shellFragment(looks[look].shellFragment),
        uniforms: { ...looks[look].shellUniforms, ...projection },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: DoubleSide,
        blending: AdditiveBlending,
        toneMapped: false,
      })
      materials.set(key, m)
    }
    return m
  }

  // What the view sees, 5 × 5 over the screen from the bottom row up, the centre in the middle:
  // MapLibre's globe puts a point off the globe on the horizon that way
  const viewPoints = (m: MapLibreMap): LngLatRad[] => {
    const canvas = m.getCanvas()
    const [w, h] = [canvas.clientWidth, canvas.clientHeight]
    const points: LngLatRad[] = []
    for (let j = 0; j < VIEW_SAMPLES; j++) {
      for (let i = 0; i < VIEW_SAMPLES; i++) {
        const p = m.unproject([(i / (VIEW_SAMPLES - 1)) * w, (1 - j / (VIEW_SAMPLES - 1)) * h])
        points.push({ lng: (p.lng * Math.PI) / 180, lat: (p.lat * Math.PI) / 180 })
      }
    }
    return points
  }

  let last = performance.now()
  return {
    id: 'waves',
    type: 'custom',
    renderingMode: '2d',
    onAdd(m, gl) {
      map = m
      renderer = new WebGLRenderer({ canvas: m.getCanvas(), context: gl })
      renderer.autoClear = false
      last = performance.now()
    },
    prerender() {
      if (!map || !renderer) return
      const now = performance.now()
      // Three's idea of the GL state is stale after the map's drawing
      renderer.resetState()
      const values = looks[mode].step(renderer, (now - last) / 1000, viewPoints(map))
      last = now
      const u = looks[mode].shellUniforms
      for (const [k, v] of Object.entries(values)) u[k]!.value = v
    },
    render(gl, { defaultProjectionData: p, shaderData }) {
      if (!map || !renderer) return
      ;(projection.u_projection_matrix!.value as Matrix4).fromArray(p.mainMatrix as unknown as number[])
      ;(projection.u_projection_fallback_matrix!.value as Matrix4).fromArray(p.fallbackMatrix as unknown as number[])
      ;(projection.u_projection_tile_mercator_coords!.value as Vector4).fromArray(p.tileMercatorCoords)
      ;(projection.u_projection_clipping_plane!.value as Vector4).fromArray(p.clippingPlane)
      projection.u_projection_transition!.value = p.projectionTransition
      shell.material = materialFor(mode, shaderData)
      renderer.resetState()
      renderer.setRenderTarget(null)
      renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
      renderer.render(scene, camera)
      // It never stops moving
      map.triggerRepaint()
    },
    onRemove() {
      map = undefined
    },
    show(next) {
      mode = next
      looks[next].reset()
      map?.triggerRepaint()
    },
    dispose() {
      for (const m of materials.values()) m.dispose()
      materials.clear()
      geometry.dispose()
      for (const look of Object.values<WaveSim>(looks)) look.dispose()
      renderer?.dispose()
      renderer = undefined
    },
  }
}
