// Mt. Fuji's summit crater as the survey's laser points, for Navara (scripts/day14/extract_crater.py):
// each in the color the survey gave it, with how much the ground under it faces up and how far
// its color lifts out of the photo's shadows.
//
// All 78 million points are in a quadtree of tiles, loaded only as deep as the camera needs: a
// node is opened (its children loaded and drawn with it) while its points would lie more than
// `refinePx` apart on screen. Each level holds the points its parents don't, so the nodes drawn
// together make an even thinning of the survey, down to every point (~10 cm apart) right under
// the camera. Points are drawn about `refinePx` x `overlap` wide, so they close up into ground,
// and never finer than the deepest level there.
//
// They appear behind the same front the photo surface goes out with (craterFront), first swollen
// to cover the ground as the photo did, then shrinking to points. Snow then settles on them: the
// flatter the ground, the sooner a point turns white, so the floor and the ledges whiten first
// and the walls stay streaked.
//
// Points are in the crater's West-Up-North frame: place the mesh with `geodetic` at its origin.
import { MeshDesc, setupMaterialForMRT, type MeshConfig, type MeshUpdate } from '@navaramap/three'
import { Box3, BufferGeometry, Float32BufferAttribute, Frustum, Group, Matrix4, Points, ShaderMaterial, Uint8BufferAttribute, Vector3 } from 'three'
import { craterFront } from './craterFront'

/** The quadtree's layout, from crater.json */
export type CraterTree = {
  /** West and north (m) of the extent's north-west corner */
  west: number
  north: number
  rootSize: number
  rows: number
  cols: number
  /** How far apart (m) the points lie, on flat ground, down to each level */
  spacing: number[]
  /** Past this radius (m) from the crater's centre, the levels stop at `maxLevelOut` */
  rimRadius: number
  maxLevelOut: number
}

type CraterPointsOptions = {
  /** Where the tiles are: `<url>/<level>/<row>-<col>.bin` */
  url: string
  tree: CraterTree
  /** The most a color is lifted out of the shadows (lift 255) */
  maxLift: number
  /** Open a node while its points lie this far apart on screen (px). Default: 4 */
  refinePx?: number
  /** Points are drawn this many times their spacing. Default: 1.6 */
  overlap?: number
  /** Most on-screen size (px). Default: 64 */
  maxPx?: number
  /** Tiles loading at once. Default: 6 */
  concurrency?: number
  /** Loaded tiles kept before the unused ones go. Default: 1200 */
  budget?: number
}
type Description = { craterPoints?: CraterPointsOptions }
export type CraterPointsConfig = MeshConfig & Description
type CraterPointsUpdate = MeshUpdate & Description

const vertexShader = /* glsl */ `
  attribute vec4 aColor;
  attribute float aLift;
  uniform float uMaxLift;
  uniform float uOvercast;
  uniform float uReveal;
  uniform float uSnow;
  uniform float uLight;
  uniform float uRefinePx;
  uniform float uOverlap;
  uniform vec2 uFinest; // spacing (m) of the deepest level in the crater, and past its rim
  uniform float uRimRadius;
  uniform float uMaxPx;
  uniform float uPixelRatio;
  uniform float uHalfHeight;
  varying vec3 vColor;
  ${craterFront}
  void main() {
    float f = craterFront(position);
    if (f > uReveal) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // not yet: off screen
      gl_PointSize = 0.0;
      return;
    }
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;

    // Snow holds on flat ground and slips off steep ground, and settles in drifts a few metres
    // across: a point is white once the snow's depth passes its drift's threshold
    float seed = craterNoise(position.xz / 3.0) * 0.55 + craterNoise(position.xz / 0.9) * 0.3 + craterHash(position.xz * 3.1) * 0.15;
    float hold = smoothstep(0.3, 0.97, aColor.a);
    float white = smoothstep(seed - 0.04, seed + 0.04, uSnow * (0.08 + 1.05 * hold * hold));
    // Under the overcast sky, the shadows the photo caught lift out. They're lit by the blue
    // sky alone: the more a color is lifted, the more it's turned to the rock's own grey-brown
    float lifted = aLift * uOvercast;
    float lift = mix(1.0, uMaxLift, lifted);
    float luma = dot(aColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    vec3 color = mix(aColor.rgb, luma * vec3(1.06, 1.0, 0.92), lifted);
    vec3 rock = pow(min(color * lift, vec3(1.0)), vec3(2.2)) * uLight;
    vColor = mix(rock, vec3(0.92, 0.94, 0.98) * mix(0.75, 1.0, uLight), white);

    // As wide as the points loaded here lie apart (refinePx on screen), but no finer than the
    // deepest level here; just behind the front, swollen to stand in for the photo
    float k = projectionMatrix[1][1] * uHalfHeight / max(-mv.z, 0.5);
    float finest = mix(uFinest.x, uFinest.y, smoothstep(uRimRadius - 20.0, uRimRadius + 20.0, length(position.xz)));
    float px = max(uRefinePx, finest * k) * uOverlap;
    float swell = 1.0 - smoothstep(0.0, 0.12, uReveal - f);
    gl_PointSize = clamp(px * mix(1.0, 3.0, swell), 1.0, uMaxPx) * uPixelRatio;
  }
`

// setupMaterialForMRT appends the G-buffer writes before main()'s closing brace: keep main() last
const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  void main() {
    vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
    vec2 d = gl_PointCoord - 0.5;
    if (dot(d, d) > 0.25) discard;
    gl_FragColor = vec4(vColor, 1.0);
  }
`

const HEADER = 32
const RECORD = 12

class Node {
  state: 'idle' | 'loading' | 'loaded' | 'failed' = 'idle'
  points?: Points<BufferGeometry, ShaderMaterial>
  /** Children present (bits: NW, NE, SW, SE), once loaded */
  children = 0
  /** Bounds: laid out from the grid until loaded, then the tile's own */
  readonly box = new Box3()
  wantedAt = -1

  constructor(
    readonly level: number,
    readonly row: number,
    readonly col: number,
  ) {}

  get key() {
    return `${this.level}/${this.row}-${this.col}`
  }
}

export class CraterPointsMeshDesc extends MeshDesc<CraterPointsConfig, CraterPointsUpdate, Group> {
  private config: CraterPointsConfig
  private material?: ShaderMaterial
  private readonly nodes = new Map<string, Node>()
  private roots: Node[] = []
  private loading = 0
  private frame = 0
  private readonly camera = new Vector3()
  private readonly frustum = new Frustum()
  private readonly viewMatrix = new Matrix4()
  private disposed = false

  constructor(...args: ConstructorParameters<typeof MeshDesc<CraterPointsConfig, CraterPointsUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  private get options() {
    return { refinePx: 4, overlap: 1.6, maxPx: 64, concurrency: 6, budget: 1200, ...this.config.craterPoints! }
  }

  override createMesh() {
    const { tree, maxLift, refinePx, overlap, maxPx } = this.options
    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uReveal: { value: -1 },
        uSnow: { value: 0 },
        uLight: { value: 1 },
        uMaxLift: { value: maxLift },
        uOvercast: { value: 0 },
        uRefinePx: { value: refinePx },
        uOverlap: { value: overlap },
        uFinest: { value: [tree.spacing.at(-1)!, tree.spacing[tree.maxLevelOut]!] },
        uRimRadius: { value: tree.rimRadius },
        uMaxPx: { value: maxPx },
        uPixelRatio: { value: window.devicePixelRatio },
        uHalfHeight: { value: window.innerHeight / 2 },
      },
    })
    setupMaterialForMRT(this.material)

    for (let row = 0; row < tree.rows; row++) {
      for (let col = 0; col < tree.cols; col++) this.roots.push(this.node(0, row, col))
    }
    const group = new Group()
    group.frustumCulled = false
    return group
  }

  /** The node, laid out from the grid (heights from its parent's, else the crater's) */
  private node(level: number, row: number, col: number, parent?: Node): Node {
    const key = `${level}/${row}-${col}`
    let node = this.nodes.get(key)
    if (!node) {
      const { tree } = this.options
      const size = tree.rootSize / 2 ** level
      node = new Node(level, row, col)
      const y = parent ? [parent.box.min.y, parent.box.max.y] : [-50, 300]
      node.box.min.set(tree.west - (col + 1) * size, y[0]!, tree.north - (row + 1) * size)
      node.box.max.set(tree.west - col * size, y[1]!, tree.north - row * size)
      this.nodes.set(key, node)
    }
    return node
  }

  private async load(node: Node) {
    node.state = 'loading'
    this.loading++
    try {
      const res = await fetch(`${this.options.url}/${node.level}/${node.row}-${node.col}.bin`)
      if (!res.ok) throw new Error(`${res.status}`)
      const buffer = await res.arrayBuffer()
      if (this.disposed) return
      const head = new DataView(buffer, 0, HEADER)
      const lo = [0, 1, 2].map((i) => head.getFloat32(i * 4, true))
      const hi = [3, 4, 5].map((i) => head.getFloat32(i * 4, true))
      const count = head.getUint32(24, true)
      node.children = head.getUint8(28)
      node.box.min.set(lo[0]!, lo[1]!, lo[2]!)
      node.box.max.set(hi[0]!, hi[1]!, hi[2]!)

      const data = new DataView(buffer, HEADER)
      const bytes = new Uint8Array(buffer, HEADER)
      const positions = new Float32Array(count * 3)
      const colors = new Uint8Array(count * 4)
      const lifts = new Uint8Array(count)
      for (let i = 0; i < count; i++) {
        const o = i * RECORD
        for (let a = 0; a < 3; a++) {
          positions[i * 3 + a] = lo[a]! + (data.getUint16(o + a * 2, true) / 65535) * (hi[a]! - lo[a]!)
        }
        colors.set(bytes.subarray(o + 6, o + 10), i * 4)
        lifts[i] = bytes[o + 10]!
      }
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
      geometry.setAttribute('aColor', new Uint8BufferAttribute(colors, 4, true))
      geometry.setAttribute('aLift', new Uint8BufferAttribute(lifts, 1, true))
      const points = new Points(geometry, this.material!)
      points.frustumCulled = false
      points.visible = false
      node.points = points
      this.raw?.add(points)
      node.state = 'loaded'
    } catch {
      node.state = 'failed'
    } finally {
      this.loading--
    }
  }

  private unload(node: Node) {
    if (!node.points) return
    this.raw?.remove(node.points)
    node.points.geometry.dispose()
    node.points = undefined
    node.state = 'idle'
  }

  /** Picks the nodes the camera needs, shows the loaded ones, and loads the rest, nearest first. */
  private refine() {
    const group = this.raw
    if (!group) return
    const { tree, refinePx, concurrency, budget } = this.options
    this.frame++
    group.updateWorldMatrix(true, false)
    const cam = this.view.camera.raw
    this.camera.setFromMatrixPosition(cam.matrixWorld)
    group.worldToLocal(this.camera)
    const k = (cam.projectionMatrix.elements[5]! * window.innerHeight) / 2
    // The view, in the crater's frame: nodes out of it aren't opened
    this.viewMatrix.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).multiply(group.matrixWorld)
    this.frustum.setFromProjectionMatrix(this.viewMatrix)

    const wanted: { node: Node; dist: number }[] = []
    const visit = (node: Node) => {
      node.wantedAt = this.frame
      const dist = Math.max(node.box.distanceToPoint(this.camera), 0.5)
      wanted.push({ node, dist })
      if (node.state !== 'loaded') return
      // Open it while its points (with its parents') lie too far apart on screen
      if ((tree.spacing[node.level]! * k) / dist <= refinePx || !this.frustum.intersectsBox(node.box)) return
      for (let bit = 0; bit < 4; bit++) {
        if (!(node.children & (1 << bit))) continue
        visit(this.node(node.level + 1, node.row * 2 + (bit >> 1), node.col * 2 + (bit & 1), node))
      }
    }
    for (const root of this.roots) visit(root)

    let loaded = 0
    for (const node of this.nodes.values()) {
      if (node.points) {
        node.points.visible = node.wantedAt === this.frame
        loaded++
      }
    }
    // Over budget: let go of the nodes unwanted longest
    if (loaded > budget) {
      const idle = [...this.nodes.values()].filter((n) => n.points && n.wantedAt !== this.frame).sort((a, b) => a.wantedAt - b.wantedAt)
      for (const node of idle.slice(0, loaded - budget)) this.unload(node)
    }
    // Coarse levels first, then nearest
    const queue = wanted.filter((w) => w.node.state === 'idle').sort((a, b) => a.node.level - b.node.level || a.dist - b.dist)
    for (const { node } of queue) {
      if (this.loading >= concurrency) break
      void this.load(node)
    }
  }

  /**
   * Shows the points behind the crater's front at `reveal`, under snow `snow` deep (0: none,
   * 1: the floor white, the walls streaked) and light `light` (1: the photo's own), with the
   * photo's shadows lifted by `overcast` (0: as taken, 1: all the way).
   */
  tick(reveal: number, snow: number, light: number, overcast: number): void {
    const u = this.material?.uniforms
    if (!u) return
    u.uReveal!.value = reveal
    u.uSnow!.value = snow
    u.uLight!.value = light
    u.uOvercast!.value = overcast
    u.uHalfHeight!.value = window.innerHeight / 2
    this.raw!.visible = reveal > -0.5
    this.refine()
  }

  override onDestroy(): void {
    this.disposed = true
    for (const node of this.nodes.values()) this.unload(node)
    super.onDestroy()
    this.material?.dispose()
  }
}
