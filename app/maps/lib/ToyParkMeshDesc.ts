// Day 25's wooden toy of Komazawa Olympic Park, for Navara: the board and everything on it
// (toyPark.ts), lit by the sun with its cascaded shadows: the trees in the fresh green of early
// May. `tick()` moves the peg dolls: runners round the jogging course, riders round the cycling
// course, dogs in the dog run, children at play (toyKids.ts, toySports.ts), and on the animals of Pig, Horse and Squirrel Parks
// and Giraffe Parking (toyAnimalPlay.ts).
// Place it with `geodetic` at the park's middle (its frame is West-Up-North).
import { MeshDesc, type MeshConfig, type MeshUpdate } from '@navaramap/three'
import {
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type Material,
} from 'three'
import {
  BOARD,
  PAINT,
  bicycle,
  buildingGeometry,
  dog,
  grainTexture,
  mergeGeometries,
  painted,
  pegDoll,
  pointInRing,
  ringBounds,
  slab,
  stadiumGeometry,
  towerGeometry,
  treeGeometries,
  TREE_FORM,
  type ParkData,
  type Ring,
  type TreeKind,
} from './toyPark'
import { animalPlaygrounds } from './toyAnimalPlay'
import { Kids } from './toyKids'
import { baseball, football, rectOf, tennis } from './toySports'

type ToyParkOptions = {
  data: ParkData
  /** The table the toy stands on: its colour and radius (m) */
  table?: { color: string; radius: number }
  /**
   * The park's name, faint in the table's wood: its text, middle (m east and north), size (m), the
   * way it reads (radians anticlockwise from east), the wood's colour, how strong (0-1), and the
   * font (a URL; the system's sans-serif till it loads)
   */
  name?: { text: string; at: [number, number]; size: [number, number]; angle: number; color: string; opacity: number; font?: string }
}
type Description = { toyPark?: ToyParkOptions }
export type ToyParkConfig = MeshConfig & Description
type ToyParkUpdate = MeshUpdate & Description

// Crown colours in early May, by kind (each tree a shade lighter or darker)
const CROWNS: Record<TreeKind, string> = {
  cherry: '#8fcb5e',
  zelkova: '#a6d66a',
  maple: '#b6dc72',
  ginkgo: '#c2e07a',
  evergreen: '#3f8a4c',
}

/** A closed path, sampled by distance along it */
class Loop {
  readonly length: number
  private cum: number[] = [0]
  constructor(private pts: Ring) {
    // Run it anticlockwise
    let a = 0
    for (let i = 0; i < pts.length - 1; i++) a += pts[i]![0] * pts[i + 1]![1] - pts[i + 1]![0] * pts[i]![1]
    if (a < 0) this.pts = [...pts].reverse()
    for (let i = 1; i < this.pts.length; i++) {
      this.cum.push(this.cum[i - 1]! + Math.hypot(this.pts[i]![0] - this.pts[i - 1]![0], this.pts[i]![1] - this.pts[i - 1]![1]))
    }
    this.length = this.cum[this.cum.length - 1]!
  }
  /** Where `s` metres along is, and the way it heads (unit) */
  at(s: number): [number, number, number, number] {
    s = ((s % this.length) + this.length) % this.length
    let lo = 0
    let hi = this.cum.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (this.cum[mid]! <= s) lo = mid
      else hi = mid
    }
    const a = this.pts[lo]!
    const b = this.pts[hi]!
    const len = this.cum[hi]! - this.cum[lo]! || 1
    const t = (s - this.cum[lo]!) / len
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (b[0] - a[0]) / len, (b[1] - a[1]) / len]
  }
}

type Walker = { s: number; speed: number; side: number; phase: number; color: Color }
type Dog = { x: number; y: number; tx: number; ty: number; speed: number; phase: number; wait: number }

// Fewer than the children: they're the life of the park
const RUNNERS = 16
const RIDERS = 7
// The grown-ups and the dogs, far larger than life so they read at a glance
const ADULT = 2
const DOG = 2.2
const DOGS = 6
const SHIRTS = ['#e8483c', '#2f7fd8', '#f2c230', '#35a364', '#f07fb0', '#ffffff', '#7e57c2', '#ff8a3d', '#1fb5c4']

export class ToyParkMeshDesc extends MeshDesc<ToyParkConfig, ToyParkUpdate, Group> {
  private config: ToyParkConfig
  private disposables: { dispose(): void }[] = []
  private crowns: InstancedMesh[] = []
  private trunks?: InstancedMesh
  private runners: { body: InstancedMesh; head: InstancedMesh; who: Walker[]; loop: Loop }[] = []
  private dogs?: { mesh: InstancedMesh; who: Dog[]; pick: () => [number, number] }
  private bikes?: InstancedMesh
  private kids?: Kids
  private last = 0

  constructor(...args: ConstructorParameters<typeof MeshDesc<ToyParkConfig, ToyParkUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  private standard(params: ConstructorParameters<typeof MeshStandardMaterial>[0]): MeshStandardMaterial {
    const m = new MeshStandardMaterial(params)
    this.ctx.applyShadowMaterial(m)
    this.disposables.push(m)
    return m
  }

  private mesh(geometry: BufferGeometry, material: Material, cast = true): Mesh {
    const m = new Mesh(geometry, material)
    m.castShadow = cast
    m.receiveShadow = true
    this.disposables.push(geometry)
    return m
  }

  override createMesh() {
    const d = this.config.toyPark!.data
    const outer = new Group()
    // Built x east, y up, z south; Navara's frame here is x west, y up, z north
    const toy = new Group()
    toy.rotation.y = Math.PI
    outer.add(toy)

    // The board: bare wood, its edge well rounded
    const wood = grainTexture(false)
    wood.repeat.set(1 / 90, 1 / 90)
    const fine = grainTexture(true)
    fine.repeat.set(1 / 45, 1 / 45)
    this.disposables.push(wood, fine)
    toy.add(this.mesh(slab(d.park, 0, BOARD, 3, 3), this.standard({ map: wood, roughness: 0.72 })))
    const table = this.config.toyPark!.table
    if (table) {
      const tableMat = this.standard({ color: table.color, roughness: 0.95 })
      toy.add(this.mesh(new CircleGeometry(table.radius, 96).rotateX(-Math.PI / 2).translate(0, -0.02, 0), tableMat, false))
    }
    const name = this.config.toyPark!.name
    if (name) toy.add(this.nameMark(name))

    // Painted pieces: one draw for the lot
    const paintGeoms: BufferGeometry[] = []
    const water: BufferGeometry[] = []
    const kindOf = (a: ParkData['areas'][number]) => (a.kind === 'pitch' && a.sport && PAINT[a.sport] ? a.sport : a.kind)
    d.areas.forEach((a, i) => {
      const k = kindOf(a)
      const p = PAINT[k]
      if (!p) return
      // Smaller pieces a hair higher, so overlapping ones don't fight
      const g = slab(a.rings, BOARD, BOARD + p.h + i * 0.004)
      if (k === 'pool' || k === 'swimming_pool') water.push(painted(g, p.color))
      else paintGeoms.push(painted(g, p.color))
    })
    for (const k of ['walk', 'family', 'cycle', 'jog'] as const) {
      for (const p of d.surfaces[k]) paintGeoms.push(painted(slab(p, BOARD, BOARD + PAINT[k]!.h, 0.25), PAINT[k]!.color))
    }
    const st = stadiumGeometry(d.stadium)
    paintGeoms.push(...st.paint)
    d.buildings.forEach((b, i) => paintGeoms.push(...buildingGeometry(b, i)))
    const tower = d.buildings.find((b) => b.kind === 'tower')
    if (tower) paintGeoms.push(...towerGeometry(tower.ring))
    const paint = this.standard({ vertexColors: true, map: fine, roughness: 0.62 })
    toy.add(this.mesh(mergeGeometries(paintGeoms)!, paint))

    if (water.length) toy.add(this.mesh(mergeGeometries(water)!, this.standard({ vertexColors: true, roughness: 0.12, metalness: 0.05 }), false))

    // White lines: the pitches' (from the data) and the track's lanes
    const lineGeoms = [
      ...d.lines.map((p) => slab(p, BOARD, BOARD + PAINT.pitch!.h + 0.06, 0)),
      ...st.lines,
    ]
    toy.add(this.mesh(mergeGeometries(lineGeoms)!, this.standard({ color: '#fbfaf4', roughness: 0.5, side: DoubleSide }), false))

    this.addTrees(toy, d)
    this.addFigures(toy, d)

    // Children at play: on the equipment, at games on the pitches, and on the animals the
    // playgrounds are named after
    this.kids = new Kids(
      d,
      { play: BOARD + PAINT.playground!.h, lawn: BOARD + PAINT.lawn!.h, pool: BOARD + PAINT.pool!.h, family: BOARD + PAINT.family!.h },
      paint,
      this.standard({ roughness: 0.6, map: fine }),
      this.standard({ color: '#f7c79a', roughness: 0.6 }),
      (kids) => {
        // Games on the pitches: football on the football pitches and in the stadium, baseball on
        // the baseball fields, tennis on the courts
        const pitchH = BOARD + PAINT.pitch!.h
        let n = 0
        const used: { cx: number; cy: number; L: number; W: number }[] = []
        for (const a of d.areas) {
          if (a.kind !== 'pitch') continue
          const r = rectOf(a.rings[0]!)
          const area = r.L * r.W
          // (some pitches are in OSM twice, or one inside another: one game a place)
          if (used.some((o) => Math.hypot(o.cx - r.cx, o.cy - r.cy) < Math.min(o.W, r.W) / 2)) continue
          used.push(r)
          if ((!a.sport || a.sport === 'soccer') && area > 3_000) football(kids, r, pitchH, n++)
          else if (a.sport === 'baseball' && area > 3_000) baseball(kids, r, pitchH, n++)
          else if (a.sport === 'tennis' && area > 600) tennis(kids, r, pitchH, n++)
        }
        const st = d.stadium
        football(kids, { cx: st.center[0], cy: st.center[1], angle: st.angle, L: 100, W: 62 }, BOARD + PAINT.field!.h, n++, 4)
        // And the animals the playgrounds are named after, to climb, ride and slide down
        animalPlaygrounds(kids, d, BOARD + PAINT.playground!.h, BOARD + PAINT.parking!.h)
      },
    )
    toy.add(this.kids.group)
    return outer
  }

  /** The park's name in the table's wood, faint: letters filled with grain, like a watermark */
  private nameMark(o: NonNullable<ToyParkOptions['name']>): Mesh {
    const [W, D] = o.size
    const c = document.createElement('canvas')
    c.width = 2048
    c.height = Math.round((2048 * D) / W)
    const draw = (family: string) => {
      const g = c.getContext('2d')!
      g.clearRect(0, 0, c.width, c.height)
      // Grain: wavy darker and lighter lines along the letters
      let seed = 11
      const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
      g.fillStyle = o.color
      g.fillRect(0, 0, c.width, c.height)
      for (let i = 0; i < 160; i++) {
        const y0 = rnd() * c.height
        const amp = 2 + rnd() * 5
        const freq = ((1 + Math.floor(rnd() * 3)) * 2 * Math.PI) / c.width
        const ph = rnd() * 6.28
        g.strokeStyle = rnd() < 0.6 ? `rgba(90, 50, 20, ${0.15 + rnd() * 0.3})` : `rgba(255, 235, 200, ${0.1 + rnd() * 0.2})`
        g.lineWidth = 1 + rnd() * 4
        g.beginPath()
        for (let x = 0; x <= c.width; x += 8) {
          const y = y0 + amp * Math.sin(x * freq + ph)
          if (x === 0) g.moveTo(x, y)
          else g.lineTo(x, y)
        }
        g.stroke()
      }
      // Only where the letters are
      g.globalCompositeOperation = 'destination-in'
      // As big as fits: most of the height, or nine tenths of the width
      const spaced = (px: number) => {
        g.font = `700 ${px}px ${family}`
        ;(g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${px * 0.06}px`
        return g.measureText(o.text).width
      }
      let size = c.height * 0.72
      size *= Math.min(1, (c.width * 0.9) / spaced(size))
      spaced(size)
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillStyle = '#000'
      g.fillText(o.text, c.width / 2, c.height * 0.54)
      g.globalCompositeOperation = 'source-over'
    }
    draw('sans-serif')
    const texture = new CanvasTexture(c)
    texture.colorSpace = SRGBColorSpace
    texture.anisotropy = 8
    if (o.font) {
      new FontFace('ToyParkName', `url(${o.font})`, { weight: '700' })
        .load()
        .then((face) => {
          document.fonts.add(face)
          draw('ToyParkName')
          texture.needsUpdate = true
        })
        .catch(() => {})
    }
    const material = this.standard({ map: texture, transparent: true, opacity: o.opacity, roughness: 0.95, depthWrite: false })
    const geometry = new PlaneGeometry(W, D).rotateX(-Math.PI / 2).rotateY(o.angle).translate(o.at[0], 0.05, -o.at[1])
    this.disposables.push(texture)
    const m = this.mesh(geometry, material, false)
    m.receiveShadow = true
    return m
  }

  private addTrees(toy: Group, d: ParkData) {
    const geoms = treeGeometries()
    this.disposables.push(geoms.trunk)
    const crownMat = this.standard({ map: grainTexture(true), roughness: 0.7 })
    crownMat.map!.repeat.set(0.25, 0.25)
    this.disposables.push(crownMat.map!)
    const trunkMat = this.standard({ color: '#9a6b45', roughness: 0.75 })
    for (const shape of ['round', 'cone', 'ginkgo'] as const) {
      const trees = d.trees.map((t, i) => [t, i] as const).filter(([t]) => TREE_FORM[t[2]].shape === shape).map(([, i]) => i)
      const mesh = new InstancedMesh(geoms[shape], crownMat, trees.length)
      this.disposables.push(geoms[shape])
      mesh.castShadow = mesh.receiveShadow = true
      mesh.frustumCulled = false
      // Each crown on its trunk, in its kind's green, a shade lighter or darker
      const m = new Matrix4()
      const c = new Color()
      trees.forEach((ti, k) => {
        const [x, y, kind, size] = d.trees[ti]!
        const f = TREE_FORM[kind]
        const r = f.r * size
        m.makeScale(r, r, r).setPosition(x, BOARD + 0.6 + f.trunk * size + r * 0.55, -y)
        mesh.setMatrixAt(k, m)
        mesh.setColorAt(k, c.set(CROWNS[kind]).offsetHSL(0, 0, (((ti * 0.618) % 1) - 0.5) * 0.08))
      })
      this.crowns.push(mesh)
      toy.add(mesh)
    }
    const trunks = new InstancedMesh(geoms.trunk, trunkMat, d.trees.length)
    trunks.castShadow = trunks.receiveShadow = true
    trunks.frustumCulled = false
    const m = new Matrix4()
    d.trees.forEach(([x, y, kind, size], i) => {
      const f = TREE_FORM[kind]
      const h = f.trunk * size
      m.makeScale(size * 6, h + f.r * size * 0.5, size * 6).setPosition(x, BOARD + 0.6, -y)
      trunks.setMatrixAt(i, m)
    })
    this.trunks = trunks
    toy.add(trunks)
  }

  private addFigures(toy: Group, d: ParkData) {
    const { body, head } = pegDoll()
    this.disposables.push(body, head)
    const bodyMat = this.standard({ roughness: 0.55, map: grainTexture(true) })
    bodyMat.map!.repeat.set(0.2, 0.2)
    this.disposables.push(bodyMat.map!)
    const headMat = this.standard({ color: '#f1d2a8', roughness: 0.6 })
    let seed = 25
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const make = (loop: Ring, n: number, speed: [number, number], width: number) => {
      const who: Walker[] = Array.from({ length: n }, () => ({
        s: rnd() * 3000,
        speed: speed[0] + rnd() * (speed[1] - speed[0]),
        side: (rnd() - 0.5) * width,
        phase: rnd() * 6.28,
        color: new Color(SHIRTS[Math.floor(rnd() * SHIRTS.length)]!),
      }))
      const b = new InstancedMesh(body, bodyMat, n)
      const h = new InstancedMesh(head, headMat, n)
      for (const im of [b, h]) {
        im.castShadow = im.receiveShadow = true
        im.instanceMatrix.setUsage(DynamicDrawUsage)
        im.frustumCulled = false
        toy.add(im)
      }
      who.forEach((w, i) => b.setColorAt(i, w.color))
      this.runners.push({ body: b, head: h, who, loop: new Loop(loop) })
      return { b, h }
    }
    make(d.loops.jog, RUNNERS, [22, 34], 3)
    make(d.loops.cycle, RIDERS, [40, 55], 2)
    const bike = bicycle()
    this.bikes = new InstancedMesh(bike, this.standard({ color: '#4a4f5c', roughness: 0.5 }), RIDERS)
    this.bikes.castShadow = true
    this.bikes.frustumCulled = false
    this.bikes.instanceMatrix.setUsage(DynamicDrawUsage)
    this.disposables.push(bike)
    toy.add(this.bikes)

    const run = d.areas.find((a) => a.kind === 'dog_park')
    if (run) {
      const area = run.rings[0]!
      const inside = (x: number, y: number) => pointInRing(area, x, y)
      const [x0, y0, x1, y1] = ringBounds(area)
      const pick = (): [number, number] => {
        for (let k = 0; k < 50; k++) {
          const x = x0 + rnd() * (x1 - x0)
          const y = y0 + rnd() * (y1 - y0)
          if (inside(x, y)) return [x, y]
        }
        return [(x0 + x1) / 2, (y0 + y1) / 2]
      }
      const who: Dog[] = Array.from({ length: DOGS }, () => {
        const [x, y] = pick()
        const [tx, ty] = pick()
        return { x, y, tx, ty, speed: 12 + rnd() * 12, phase: rnd() * 6.28, wait: 0 }
      })
      const g = dog()
      const mesh = new InstancedMesh(g, this.standard({ roughness: 0.6, map: grainTexture(true) }), DOGS)
      this.disposables.push(g)
      const coats = ['#c98a4b', '#f3ead8', '#3b3330', '#e0b77a', '#8a5a3a']
      who.forEach((_, i) => mesh.setColorAt(i, new Color(coats[i % coats.length]!)))
      mesh.castShadow = mesh.receiveShadow = true
      mesh.frustumCulled = false
      mesh.instanceMatrix.setUsage(DynamicDrawUsage)
      toy.add(mesh)
      this.dogs = { mesh, who, pick }
    }
  }

  /** Moves the dolls on to `now` (s) */
  tick(now: number): void {
    const dt = Math.min(0.1, this.last ? now - this.last : 0)
    this.last = now
    this.kids?.update(dt, now)
    const m = new Matrix4()
    const q = new Quaternion()
    const up = new Vector3(0, 1, 0)
    const p = new Vector3()
    const s = new Vector3()
    this.runners.forEach(({ body, head, who, loop }, li) => {
      const riding = li === 1
      const baseH = BOARD + (riding ? PAINT.cycle!.h : PAINT.jog!.h)
      who.forEach((w, i) => {
        w.s += w.speed * dt
        const [x, y, dx, dy] = loop.at(w.s)
        // To the right of the way they head, by their own offset
        const px = x + dy * w.side
        const py = y - dx * w.side
        const bob = riding ? 0 : Math.abs(Math.sin(now * 6.5 + w.phase)) * 1.2 * ADULT
        q.setFromAxisAngle(up, Math.atan2(dy, dx))
        p.set(px, baseH + bob + (riding ? 3.2 * ADULT : 0), -py)
        s.setScalar(ADULT)
        m.compose(p, q, s)
        body.setMatrixAt(i, m)
        head.setMatrixAt(i, m)
        if (riding && this.bikes) {
          p.y = baseH
          m.compose(p, q, s)
          this.bikes.setMatrixAt(i, m)
        }
      })
      body.instanceMatrix.needsUpdate = true
      head.instanceMatrix.needsUpdate = true
    })
    if (this.bikes) this.bikes.instanceMatrix.needsUpdate = true

    if (this.dogs) {
      const { mesh, who, pick } = this.dogs
      const h = BOARD + PAINT.dog_park!.h
      who.forEach((g, i) => {
        const ddx = g.tx - g.x
        const ddy = g.ty - g.y
        const dist = Math.hypot(ddx, ddy)
        let moving = false
        if (g.wait > 0) g.wait -= dt
        else if (dist < 1) {
          ;[g.tx, g.ty] = pick()
          g.wait = Math.random() * 1.5
        } else {
          const step = Math.min(dist, g.speed * dt)
          g.x += (ddx / dist) * step
          g.y += (ddy / dist) * step
          moving = true
        }
        const hop = moving ? Math.abs(Math.sin(now * 14 + g.phase)) * 0.9 * DOG : 0
        q.setFromAxisAngle(up, Math.atan2(ddy, ddx))
        p.set(g.x, h + hop, -g.y)
        s.setScalar(DOG)
        m.compose(p, q, s)
        mesh.setMatrixAt(i, m)
      })
      mesh.instanceMatrix.needsUpdate = true
    }
  }

  override onDestroy(): void {
    for (const x of this.disposables) x.dispose()
    for (const mesh of this.crowns) mesh.dispose()
    this.trunks?.dispose()
    this.kids?.dispose()
    super.onDestroy()
  }
}
