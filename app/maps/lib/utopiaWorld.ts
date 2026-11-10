// The Day 8 plush world: patchwork felt hills, a stitched fabric road with piping, puffy trees,
// mushrooms, button flowers, giant teddy bears, rainbows and clouds. All built in code, in
// pastels, with a velvety sheen.
import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  type Object3D,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  ShaderMaterial,
  SphereGeometry,
  type Texture,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from 'three'
import { COURSE_M, Course, ROAD_HALF_WIDTH } from './utopiaCourse'

export const PASTELS = {
  pink: '#ffb3c8',
  peach: '#ffcfa6',
  lemon: '#fff0a0',
  mint: '#b6eecd',
  sky: '#aed8ff',
  lavender: '#d5c3ff',
  lilac: '#f5c2ee',
  cream: '#fff5e4',
}
export const FOG = '#ffe4ee'

// Seeded, so the world is the same on every visit
export function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return [c, c.getContext('2d')!] as const
}

// Felt fuzz for every surface's bump map
export function feltTexture(rand: () => number) {
  const [c, ctx] = canvas(256, 256)
  ctx.fillStyle = '#808080'
  ctx.fillRect(0, 0, 256, 256)
  for (let k = 0; k < 9000; k++) {
    const g = 90 + rand() * 80
    ctx.fillStyle = `rgb(${g},${g},${g})`
    const x = rand() * 256
    const y = rand() * 256
    const a = rand() * Math.PI
    // Short fibres, drawn on every wrapped side so the tile repeats seamlessly
    for (const [ox, oy] of [[0, 0], [-256, 0], [0, -256], [-256, -256]] as const) {
      ctx.save()
      ctx.translate(x + ox, y + oy)
      ctx.rotate(a)
      ctx.fillRect(-3, -0.6, 6, 1.2)
      ctx.restore()
    }
  }
  const t = new CanvasTexture(c)
  t.wrapS = t.wrapT = RepeatWrapping
  return t
}

function stitches(ctx: CanvasRenderingContext2D, pts: [number, number][], dash: number, gap: number, color: string, width: number) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineCap = 'round'
  ctx.setLineDash([dash, gap])
  ctx.beginPath()
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
  ctx.stroke()
  ctx.restore()
}

function speckle(ctx: CanvasRenderingContext2D, rand: () => number, x: number, y: number, w: number, h: number, n: number) {
  for (let k = 0; k < n; k++) {
    ctx.fillStyle = rand() < 0.5 ? 'rgba(255,255,255,0.10)' : 'rgba(120,90,110,0.06)'
    ctx.fillRect(x + rand() * w, y + rand() * h, 1 + rand() * 2, 1 + rand() * 2)
  }
}

// Patchwork of felt squares, each stitched round its edge; 4×4 squares per tile
function patchworkTexture(rand: () => number) {
  const size = 1024
  const n = 4
  const p = size / n
  const greens = ['#a8e8bd', '#c2eeaa', '#9fe0c8', '#d2f2b0', '#b4e6cc', '#c8ecbc', '#fbe8a2', '#ffd0bb']
  const [c, ctx] = canvas(size, size)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      // Mostly meadow greens, now and then a lemon or peach square
      ctx.fillStyle = greens[Math.floor(rand() ** 1.6 * greens.length)]!
      ctx.fillRect(i * p, j * p, p, p)
      speckle(ctx, rand, i * p, j * p, p, p, 1400)
      ctx.strokeStyle = 'rgba(110,140,120,0.22)'
      ctx.lineWidth = 3
      ctx.strokeRect(i * p, j * p, p, p)
      const m = 14
      stitches(
        ctx,
        [[i * p + m, j * p + m], [i * p + p - m, j * p + m], [i * p + p - m, j * p + p - m], [i * p + m, j * p + p - m], [i * p + m, j * p + m]],
        14,
        10,
        'rgba(255,255,255,0.85)',
        4,
      )
    }
  }
  const t = new CanvasTexture(c)
  t.wrapS = t.wrapT = RepeatWrapping
  t.colorSpace = SRGBColorSpace
  return t
}

// Lavender fabric road: stitches down both edges and a stitched centre line
function roadTexture(rand: () => number) {
  const [c, ctx] = canvas(256, 512)
  ctx.fillStyle = '#d9c2ff'
  ctx.fillRect(0, 0, 256, 512)
  // A faint weave
  for (let y = 0; y < 512; y += 4) {
    ctx.fillStyle = y % 8 ? 'rgba(255,255,255,0.08)' : 'rgba(140,110,190,0.06)'
    ctx.fillRect(0, y, 256, 2)
  }
  speckle(ctx, rand, 0, 0, 256, 512, 2500)
  stitches(ctx, [[22, 0], [22, 512]], 18, 14, 'rgba(255,255,255,0.9)', 5)
  stitches(ctx, [[234, 0], [234, 512]], 18, 14, 'rgba(255,255,255,0.9)', 5)
  stitches(ctx, [[128, 6], [128, 512]], 70, 58, '#fff6b8', 9)
  const t = new CanvasTexture(c)
  t.wrapS = t.wrapT = RepeatWrapping
  t.colorSpace = SRGBColorSpace
  return t
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`
const SKY_FRAG = /* glsl */ `
uniform vec3 uTop, uHorizon, uSunDir;
varying vec3 vDir;
void main() {
  float h = clamp(vDir.y, 0.0, 1.0);
  vec3 col = mix(uHorizon, uTop, pow(h, 0.55));
  float sun = max(dot(normalize(vDir), uSunDir), 0.0);
  col += vec3(1.0, 0.93, 0.8) * (pow(sun, 400.0) * 0.6 + pow(sun, 12.0) * 0.18);
  gl_FragColor = vec4(col, 1.0);
}`

export function buildWorld(course: Course, sunDir: Vector3, anisotropy: number) {
  const rand = rng(8)
  const root = new Group()
  const textures: Texture[] = []
  const felt = feltTexture(rand)
  textures.push(felt)

  const plush = (color: string | Color, opts: { bump?: number } = {}) =>
    new MeshPhysicalMaterial({
      color,
      roughness: 0.92,
      sheen: 1,
      sheenRoughness: 0.55,
      sheenColor: new Color('#ffffff'),
      bumpMap: felt,
      bumpScale: opts.bump ?? 1.2,
    })

  // Sky
  const sky = new Mesh(
    new SphereGeometry(2600, 32, 16),
    new ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: BackSide,
      depthWrite: false,
      uniforms: {
        uTop: { value: new Color('#9fd0ff') },
        uHorizon: { value: new Color(FOG) },
        uSunDir: { value: sunDir },
      },
    }),
  )
  sky.renderOrder = -1
  sky.frustumCulled = false
  root.add(sky)

  // Ground
  const EXTENT = 2200
  const ground = new PlaneGeometry(EXTENT, EXTENT, 440, 440).rotateX(-Math.PI / 2)
  const pos = ground.attributes.position as BufferAttribute
  for (let k = 0; k < pos.count; k++) pos.setY(k, course.groundAt(pos.getX(k), pos.getZ(k)))
  ground.computeVertexNormals()
  const patchwork = patchworkTexture(rand)
  patchwork.anisotropy = anisotropy
  patchwork.repeat.set(EXTENT / 96, EXTENT / 96)
  textures.push(patchwork)
  const groundMat = plush('#ffffff')
  groundMat.map = patchwork
  groundMat.bumpScale = 0.6
  const groundMesh = new Mesh(ground, groundMat)
  groundMesh.receiveShadow = true
  root.add(groundMesh)

  // Road: a ribbon a little above the flattened ground, its fabric repeating every 8 m
  const road = roadTexture(rand)
  road.anisotropy = anisotropy
  textures.push(road)
  const rows = COURSE_M + 1
  const rp = new Float32Array(rows * 2 * 3)
  const ruv = new Float32Array(rows * 2 * 2)
  const ri: number[] = []
  for (let k = 0; k < rows; k++) {
    const s = k % COURSE_M
    const lx = course.tz[s]!
    const lz = -course.tx[s]!
    const y = course.y[s]! + 0.03
    for (let side = 0; side < 2; side++) {
      const w = side ? -ROAD_HALF_WIDTH : ROAD_HALF_WIDTH
      rp.set([course.x[s]! + lx * w, y, course.z[s]! + lz * w], (k * 2 + side) * 3)
      ruv.set([side, k / 8], (k * 2 + side) * 2)
    }
    if (k < rows - 1) {
      const a = k * 2
      ri.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  const roadGeom = new BufferGeometry()
  roadGeom.setAttribute('position', new BufferAttribute(rp, 3))
  roadGeom.setAttribute('uv', new BufferAttribute(ruv, 2))
  roadGeom.setIndex(ri)
  roadGeom.computeVertexNormals()
  const roadMat = plush('#ffffff', { bump: 0.5 })
  roadMat.map = road
  roadMat.polygonOffset = true
  roadMat.polygonOffsetFactor = -2
  const roadMesh = new Mesh(roadGeom, roadMat)
  roadMesh.receiveShadow = true
  root.add(roadMesh)

  // Piping: a soft rope down each edge of the road, like the edge of a cushion
  for (const [side, color] of [[1, PASTELS.pink], [-1, PASTELS.sky]] as const) {
    const pts: Vector3[] = []
    for (let s = 0; s < COURSE_M; s += 4) {
      const w = side * (ROAD_HALF_WIDTH + 0.25)
      pts.push(new Vector3(course.x[s]! + course.tz[s]! * w, course.y[s]! + 0.2, course.z[s]! - course.tx[s]! * w))
    }
    const pipe = new Mesh(new TubeGeometry(new CatmullRomCurve3(pts, true), 2000, 0.32, 8, true), plush(color))
    pipe.castShadow = pipe.receiveShadow = true
    root.add(pipe)
  }

  // Keep scenery off the road and out of each other's way
  const taken: { x: number; z: number; r: number }[] = []
  const free = (x: number, z: number, r: number, roadGap: number) =>
    course.nearest(x, z).d > ROAD_HALF_WIDTH + roadGap + r && taken.every((o) => Math.hypot(o.x - x, o.z - z) > o.r + r)

  // Giant teddy bears sitting by the road, watching you go by
  const bearColors = [PASTELS.pink, PASTELS.peach, PASTELS.lavender, PASTELS.lemon, PASTELS.sky, PASTELS.mint, '#f3d7c0']
  const bears: Group[] = []
  ;[160, 430, 700, 960, 1240, 1520, 1790].forEach((s, i) => {
    const side = i % 2 ? 1 : -1
    const off = ROAD_HALF_WIDTH + 14 + rand() * 8
    const x = course.x[s]! + course.tz[s]! * off * side
    const z = course.z[s]! - course.tx[s]! * off * side
    const scale = 3.6 + rand() * 2.2
    const bear = makeBear(plush, bearColors[i % bearColors.length]!)
    bear.scale.setScalar(scale)
    bear.position.set(x, course.groundAt(x, z) - 0.15 * scale, z)
    // Face a little ahead up the road, toward the oncoming rider
    const look = (s - 25 + COURSE_M) % COURSE_M
    bear.rotation.y = Math.atan2(course.x[look]! - x, course.z[look]! - z)
    bear.userData.phase = rand() * Math.PI * 2
    bears.push(bear)
    root.add(bear)
    taken.push({ x, z, r: 2.2 * scale })
  })

  // Rainbows: one arching over the start line, two big ones far off
  const bands = [PASTELS.pink, PASTELS.peach, PASTELS.lemon, PASTELS.mint, PASTELS.sky, PASTELS.lavender]
  const rainbow = (radius: number, tube: number) => {
    const g = new Group()
    bands.forEach((c, i) => {
      const m = new Mesh(new TorusGeometry(radius + (bands.length - 1 - i) * tube * 1.9, tube, 12, 64, Math.PI), plush(c))
      m.castShadow = true
      g.add(m)
    })
    return g
  }
  {
    const s = 6
    const arch = rainbow(ROAD_HALF_WIDTH + 2.4, 0.34)
    arch.position.set(course.x[s]!, course.y[s]! - 0.3, course.z[s]!)
    arch.rotation.y = Math.atan2(course.tx[s]!, course.tz[s]!)
    root.add(arch)
    taken.push({ x: course.x[s]!, z: course.z[s]!, r: 14 })
  }
  for (const [x, z, r] of [[-700, -520, 130], [640, 560, 100]] as const) {
    const arch = rainbow(r, r * 0.05)
    arch.position.set(x, course.groundAt(x, z) - r * 0.15, z)
    arch.rotation.y = Math.atan2(-x, -z)
    root.add(arch)
  }

  // Instanced scenery, scattered with rejection sampling
  const m4 = new Matrix4()
  const q = new Quaternion()
  const e = new Euler()
  type Inst = { p: Vector3; r: Euler; s: Vector3; c: Color }
  const instanced = (geom: BufferGeometry, items: Inst[], shadow = true) => {
    const mesh = new InstancedMesh(geom, plush('#ffffff'), items.length)
    items.forEach((it, k) => {
      mesh.setMatrixAt(k, m4.compose(it.p, q.setFromEuler(it.r), it.s))
      mesh.setColorAt(k, it.c)
    })
    mesh.castShadow = shadow
    mesh.receiveShadow = true
    mesh.computeBoundingSphere()
    root.add(mesh)
    return mesh
  }
  const scatter = (count: number, rMin: number, rMax: number, size: () => number, roadGap: number, place: (x: number, z: number, y: number, size: number) => void) => {
    for (let k = 0, tries = 0; k < count && tries < count * 40; tries++) {
      const a = rand() * Math.PI * 2
      const r = Math.sqrt(rMin ** 2 + rand() * (rMax ** 2 - rMin ** 2))
      const x = Math.cos(a) * r
      const z = Math.sin(a) * r
      const sz = size()
      if (!free(x, z, sz, roadGap)) continue
      taken.push({ x, z, r: sz * 0.9 })
      place(x, z, course.groundAt(x, z), sz)
      k++
    }
  }
  const pick = (list: string[]) => new Color(list[Math.floor(rand() * list.length)]!)

  // Lollipop trees: a stitched puffball on a cream trunk
  const crowns: Inst[] = []
  const seams: Inst[] = []
  const trunks: Inst[] = []
  const crownColors = [PASTELS.mint, PASTELS.mint, '#c8f2b4', PASTELS.pink, PASTELS.lilac, PASTELS.lemon, PASTELS.peach, PASTELS.sky]
  scatter(520, 0, 1000, () => 2.4 + rand() ** 2 * 4, 3, (x, z, y, R) => {
    const trunkH = R * (0.9 + rand() * 0.6)
    const c = pick(crownColors)
    const cy = y + trunkH + R * 0.8
    const yaw = rand() * Math.PI
    trunks.push({ p: new Vector3(x, y + trunkH / 2, z), r: new Euler(), s: new Vector3(R * 0.16, trunkH, R * 0.16), c: new Color('#f6dcc0') })
    crowns.push({ p: new Vector3(x, cy, z), r: new Euler(0, yaw, 0), s: new Vector3(R, R * 1.05, R), c })
    seams.push({ p: new Vector3(x, cy, z), r: new Euler(0, yaw, 0), s: new Vector3(R, R * 1.05, R), c: c.clone().multiplyScalar(0.86) })
  })
  instanced(new SphereGeometry(1, 28, 18), crowns)
  instanced(new TorusGeometry(1.0, 0.035, 6, 48), seams, false)
  instanced(new CylinderGeometry(1, 1.25, 1, 12), trunks)

  // Round bushes, half sunk into the felt
  const bushes: Inst[] = []
  scatter(420, 0, 950, () => 0.8 + rand() * 1.6, 1.2, (x, z, y, R) => {
    bushes.push({ p: new Vector3(x, y + R * 0.3, z), r: new Euler(0, rand() * 6, 0), s: new Vector3(R * 1.25, R, R * 1.1), c: pick([PASTELS.mint, '#cdf3c0', PASTELS.lilac, PASTELS.pink]) })
  })
  instanced(new SphereGeometry(1, 20, 12), bushes)

  // Mushrooms: a domed cap with polka dots on a squat stalk
  const stalks: Inst[] = []
  const caps: Inst[] = []
  const dots: Inst[] = []
  scatter(110, 0, 900, () => 0.9 + rand() ** 3 * 4, 1.5, (x, z, y, R) => {
    const h = R * 1.1
    stalks.push({ p: new Vector3(x, y + h / 2, z), r: new Euler(), s: new Vector3(R * 0.38, h, R * 0.38), c: new Color(PASTELS.cream) })
    caps.push({ p: new Vector3(x, y + h * 0.92, z), r: new Euler(), s: new Vector3(R, R * 0.75, R), c: pick(['#ff9fb6', PASTELS.peach, PASTELS.lavender, '#ff8fa8']) })
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2 + rand()
      const el = 0.35 + rand() * 0.6
      const dir = new Vector3(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el))
      dots.push({
        p: new Vector3(x + dir.x * R, y + h * 0.92 + dir.y * R * 0.75, z + dir.z * R),
        r: e.setFromQuaternion(q.setFromUnitVectors(new Vector3(0, 1, 0), dir)).clone(),
        s: new Vector3(R * 0.16, R * 0.03, R * 0.16),
        c: new Color('#ffffff'),
      })
    }
  })
  instanced(new CylinderGeometry(0.8, 1, 1, 14), stalks)
  instanced(new SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), caps)
  instanced(new CylinderGeometry(1, 1, 1, 12), dots, false)

  // Button flowers along the verges: a four-holed button on a short stem
  const buttons: Inst[] = []
  const centers: Inst[] = []
  for (let k = 0; k < 2600; k++) {
    const s = rand() * COURSE_M
    const side = rand() < 0.5 ? 1 : -1
    const off = side * (ROAD_HALF_WIDTH + 1.4 + rand() ** 1.5 * 26)
    const x = course.at(course.x, s) + course.at(course.tz, s) * off
    const z = course.at(course.z, s) - course.at(course.tx, s) * off
    if (!free(x, z, 0.3, 1)) continue
    const y = course.groundAt(x, z)
    const R = 0.18 + rand() * 0.22
    const tilt = new Euler(Math.PI / 2 - 0.5 + rand() * 0.3, rand() * Math.PI * 2, 0, 'YXZ')
    const c = pick([PASTELS.pink, PASTELS.lemon, PASTELS.lavender, PASTELS.sky, '#ffffff', PASTELS.peach])
    buttons.push({ p: new Vector3(x, y + 0.3 + R, z), r: tilt, s: new Vector3(R, R * 0.25, R), c })
    centers.push({ p: new Vector3(x, y + 0.3 + R, z), r: tilt, s: new Vector3(R * 0.35, R * 0.4, R * 0.35), c: c.clone().lerp(new Color('#ffffff'), 0.6) })
  }
  instanced(new CylinderGeometry(1, 1, 1, 16), buttons, false)
  instanced(new CylinderGeometry(1, 1, 1, 10), centers, false)

  // Clouds: puffs of white, slowly circling
  const clouds = new Group()
  const puffs: Inst[] = []
  for (let k = 0; k < 34; k++) {
    const a = rand() * Math.PI * 2
    const r = 150 + rand() * 900
    const cx = Math.cos(a) * r
    const cz = Math.sin(a) * r
    const cy = 70 + rand() * 90
    const big = 8 + rand() * 10
    for (let j = 0; j < 6; j++) {
      const R = big * (0.55 + rand() * 0.5)
      puffs.push({
        p: new Vector3(cx + (j - 2.5) * big * 0.55 + rand() * 4, cy + rand() * big * 0.3, cz + (rand() - 0.5) * big * 0.8),
        r: new Euler(),
        s: new Vector3(R, R * 0.8, R),
        c: new Color('#ffffff').lerp(new Color(PASTELS.pink), rand() * 0.15),
      })
    }
  }
  // Lit a little from within, so they stay white underneath
  const cloudMat = plush('#ffffff')
  cloudMat.emissive.set('#fff0f6')
  cloudMat.emissiveIntensity = 0.55
  const cloudMesh = new InstancedMesh(new SphereGeometry(1, 20, 14), cloudMat, puffs.length)
  puffs.forEach((it, k) => {
    cloudMesh.setMatrixAt(k, m4.compose(it.p, q.setFromEuler(it.r), it.s))
    cloudMesh.setColorAt(k, it.c)
  })
  cloudMesh.computeBoundingSphere()
  clouds.add(cloudMesh)
  root.add(clouds)

  const update = (t: number) => {
    clouds.rotation.y = t * 0.004
    for (const b of bears) {
      // A slow sway, and a little nod
      const ph = b.userData.phase as number
      b.children[0]!.rotation.z = Math.sin(t * 0.7 + ph) * 0.05
      b.children[0]!.rotation.x = Math.sin(t * 0.45 + ph * 1.3) * 0.04
    }
  }

  return { root, textures, update, plush }
}

// A sitting teddy bear about 3.6 units tall, facing +z. Its upper body is the first child, so it can sway.
export function makeBear(plush: (c: string) => MeshPhysicalMaterial, color: string) {
  const sphere = new SphereGeometry(1, 32, 20)
  const fur = plush(color)
  const light = plush(PASTELS.cream)
  const button = new MeshPhysicalMaterial({ color: '#3b2d3f', roughness: 0.25, clearcoat: 1 })
  const bear = new Group()
  const upper = new Group()
  bear.add(upper)
  const part = (parent: Object3D, mat: MeshPhysicalMaterial, p: [number, number, number], s: [number, number, number]) => {
    const m = new Mesh(sphere, mat)
    m.position.set(...p)
    m.scale.set(...s)
    m.castShadow = m.receiveShadow = true
    parent.add(m)
    return m
  }
  // Body and legs stay put
  part(bear, fur, [0, 1.15, 0], [1.05, 1.2, 0.95])
  part(bear, fur, [-0.55, 0.38, 0.62], [0.38, 0.36, 0.55])
  part(bear, fur, [0.55, 0.38, 0.62], [0.38, 0.36, 0.55])
  part(bear, light, [-0.55, 0.38, 1.12], [0.26, 0.26, 0.08])
  part(bear, light, [0.55, 0.38, 1.12], [0.26, 0.26, 0.08])
  part(bear, light, [0, 1.05, 0.72], [0.62, 0.72, 0.3])
  part(bear, fur, [-0.98, 1.35, 0.25], [0.3, 0.55, 0.3]).rotation.z = -0.5
  part(bear, fur, [0.98, 1.35, 0.25], [0.3, 0.55, 0.3]).rotation.z = 0.5
  // Head, pivoting at the neck
  upper.position.set(0, 2.1, 0)
  part(upper, fur, [0, 0.72, 0], [0.82, 0.76, 0.76])
  for (const sx of [-1, 1]) {
    part(upper, fur, [sx * 0.6, 1.32, -0.05], [0.3, 0.3, 0.16])
    part(upper, light, [sx * 0.6, 1.3, 0.06], [0.18, 0.18, 0.08])
    part(upper, button, [sx * 0.3, 0.9, 0.66], [0.09, 0.09, 0.06])
  }
  part(upper, light, [0, 0.55, 0.66], [0.36, 0.27, 0.22])
  part(upper, button, [0, 0.66, 0.86], [0.11, 0.08, 0.06])
  return bear
}

export function disposeTree(root: Object3D) {
  const mats = new Set<{ dispose(): void }>()
  const geoms = new Set<{ dispose(): void }>()
  root.traverse((o) => {
    if (o instanceof Mesh) {
      geoms.add(o.geometry)
      for (const m of [o.material].flat()) mats.add(m)
    }
  })
  mats.forEach((m) => m.dispose())
  geoms.forEach((g) => g.dispose())
}
