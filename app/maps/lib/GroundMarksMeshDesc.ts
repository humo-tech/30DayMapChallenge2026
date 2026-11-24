// Marks painted on the ground, for Navara (Day 24): what a place is, told by how it's drawn (a
// key beside the map says which is which) rather than by words on the ground. Offices are
// ringed solid and hatched, homes dotted, a university dashed, each in its own muted color; a
// station is a double ring. Each is drawn once on a canvas and laid flat on the ground, true to
// size, as a textured quad turned to `heading` (an area's axes run across and along the view
// from there). Drawn after the arcs (which add light and write no
// depth), so they stay legible under them, while the columns still stand in front.
import { MeshDesc, geodeticToVector3, setupMaterialForMRT, type MeshConfig, type MeshUpdate } from '@navaramap/three'
import {
  BufferGeometry,
  CanvasTexture,
  Float32BufferAttribute,
  Group,
  LinearMipmapLinearFilter,
  Mesh,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
} from 'three'

export type GroundMarkKind = 'offices' | 'homes' | 'university' | 'station'

/** How each kind is drawn: its color (r, g, b), outline dash (in line widths; none: solid) and fill */
export const MARK_STYLES: Record<GroundMarkKind, { rgb: [number, number, number]; dash?: [number, number]; fill: 'hatch' | 'tint' | 'none' }> = {
  offices: { rgb: [226, 200, 150], fill: 'hatch' },
  homes: { rgb: [150, 200, 160], dash: [0.01, 2.2], fill: 'tint' },
  university: { rgb: [190, 172, 235], dash: [4, 2.5], fill: 'tint' },
  station: { rgb: [255, 255, 255], fill: 'none' },
}

export type GroundMark = {
  kind: GroundMarkKind
  lng: number
  lat: number
  /** Half axes (m) of an area's ellipse, across and along the view; a station's ring radius */
  rx: number
  ry?: number
}

type GroundMarksOptions = {
  /** ECEF (m) the positions are measured from */
  anchor: { x: number; y: number; z: number }
  marks: GroundMark[]
  /** Compass bearing (deg) the marks' top faces: the camera's heading */
  heading: number
}
type Description = { groundMarks?: GroundMarksOptions }
export type GroundMarksConfig = MeshConfig & Description
type GroundMarksUpdate = MeshUpdate & Description

// Canvas pixels per metre, and the most a canvas side may take
const PX_PER_M = 1
const MAX_PX = 2048
// Lifted this far (m) over the ground, under the columns' and arcs' bases
const LIFT = 4
// Outline width (m)
const LINE = 16

// (Navara's depth buffer is logarithmic: the chunks keep the ground from cutting in)
const vertexShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`
// setupMaterialForMRT appends the G-buffer writes before main()'s closing brace, so keep main() last
const fragmentShader = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D uMap;
  varying vec2 vUv;
  void main() {
    #include <logdepthbuf_fragment>
    vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
    vec4 c = texture2D(uMap, vUv);
    if (c.a < 0.01) discard;
    gl_FragColor = c;
  }
`

const rgba = ([r, g, b]: [number, number, number], a: number) => `rgba(${r}, ${g}, ${b}, ${a})`

export function paintMark(mark: GroundMark) {
  const style = MARK_STYLES[mark.kind]
  const rx = mark.rx
  const ry = mark.ry ?? mark.rx
  const margin = LINE * 2
  const wM = 2 * (rx + margin)
  const hM = 2 * (ry + margin)
  const scale = Math.min(PX_PER_M, MAX_PX / Math.max(wM, hM))
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(wM * scale)
  canvas.height = Math.ceil(hM * scale)
  const ctx = canvas.getContext('2d')!
  const cx = canvas.width / 2
  const cy = canvas.height / 2
  const px = (m: number) => m * scale
  const line = px(LINE)
  ctx.lineCap = 'round'

  if (mark.kind === 'station') {
    // A double ring and a dot
    ctx.strokeStyle = ctx.fillStyle = rgba(style.rgb, 0.95)
    ctx.lineWidth = line * 0.9
    for (const r of [rx, rx * 0.62]) {
      ctx.beginPath()
      ctx.arc(cx, cy, px(r), 0, 2 * Math.PI)
      ctx.stroke()
    }
    ctx.beginPath()
    ctx.arc(cx, cy, px(rx * 0.22), 0, 2 * Math.PI)
    ctx.fill()
    return { canvas, wM, hM }
  }

  const ellipse = () => {
    ctx.beginPath()
    ctx.ellipse(cx, cy, px(rx), px(ry), 0, 0, 2 * Math.PI)
  }
  // The fill: hatching (widely spaced diagonals) or a faint tint
  ctx.save()
  ellipse()
  ctx.clip()
  if (style.fill === 'hatch') {
    ctx.strokeStyle = rgba(style.rgb, 0.4)
    ctx.lineWidth = line * 0.5
    const step = line * 4
    const reach = canvas.width + canvas.height
    for (let x = -reach; x < reach; x += step) {
      ctx.beginPath()
      ctx.moveTo(cx + x, cy - reach / 2)
      ctx.lineTo(cx + x + reach, cy + reach / 2)
      ctx.stroke()
    }
  } else if (style.fill === 'tint') {
    ctx.fillStyle = rgba(style.rgb, 0.12)
    ctx.fill()
  }
  ctx.restore()
  // The outline: solid, dotted or dashed
  ctx.strokeStyle = rgba(style.rgb, 0.9)
  ctx.lineWidth = line
  if (style.dash) ctx.setLineDash(style.dash.map((d) => d * line))
  ellipse()
  ctx.stroke()
  return { canvas, wM, hM }
}

export class GroundMarksMeshDesc extends MeshDesc<GroundMarksConfig, GroundMarksUpdate, Group> {
  private config: GroundMarksConfig

  constructor(...args: ConstructorParameters<typeof MeshDesc<GroundMarksConfig, GroundMarksUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  override createMesh() {
    const opts = this.config.groundMarks!
    const a = new Vector3(opts.anchor.x, opts.anchor.y, opts.anchor.z)
    const up = a.clone().normalize()
    const east = new Vector3(0, 0, 1).cross(up).normalize()
    const north = up.clone().cross(east)
    // The marks' right and top on the ground
    const h = (opts.heading * Math.PI) / 180
    const top = east.clone().multiplyScalar(Math.sin(h)).add(north.clone().multiplyScalar(Math.cos(h)))
    const right = east.clone().multiplyScalar(Math.cos(h)).sub(north.clone().multiplyScalar(Math.sin(h)))

    const group = new Group()
    group.position.copy(a)
    for (const mark of opts.marks) {
      const { canvas, wM, hM } = paintMark(mark)
      const texture = new CanvasTexture(canvas)
      texture.colorSpace = SRGBColorSpace
      texture.minFilter = LinearMipmapLinearFilter
      texture.anisotropy = 8
      const c = geodeticToVector3({ lng: mark.lng, lat: mark.lat, height: LIFT }).sub(a)
      const corner = (sx: number, sy: number) =>
        c.clone().add(right.clone().multiplyScalar((sx * wM) / 2)).add(top.clone().multiplyScalar((sy * hM) / 2))
      const quad = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new Float32BufferAttribute(quad.flatMap((p) => [p.x, p.y, p.z]), 3))
      geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2))
      geometry.setIndex([0, 1, 2, 0, 2, 3])
      const material = new ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: { uMap: { value: texture } },
        transparent: true,
        depthWrite: false,
      })
      setupMaterialForMRT(material)
      const mesh = new Mesh(geometry, material)
      mesh.frustumCulled = false
      // (after the arcs: see the top)
      mesh.renderOrder = 10
      group.add(mesh)
    }
    return group
  }

  override onDestroy(): void {
    const group = this.raw
    super.onDestroy()
    group?.traverse((o) => {
      if (!(o instanceof Mesh)) return
      o.geometry.dispose()
      ;(o.material as ShaderMaterial).uniforms.uMap!.value.dispose()
      o.material.dispose()
    })
  }
}
