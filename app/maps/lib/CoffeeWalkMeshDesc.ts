// What moves on Day 13's map, for Navara: the walker (a figure in a sweater, legs and arms
// swinging as it walks, a coffee in hand once it has had one), an arrow at its feet pointing
// the way to the nearest coffee shop not yet been in, chevrons at the doors in reach pointing
// in, and a ring of steam where a shop has just been gone into.
//
// Everything is placed in metres east (x) and north (y) of the mesh's origin: place the mesh
// with `geodetic` there. (Its frame is West-Up-North.)
import { MeshDesc, type MeshConfig, type MeshUpdate } from '@navaramap/three'
import {
  CapsuleGeometry,
  CircleGeometry,
  CylinderGeometry,
  DoubleSide,
  GreaterDepth,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  RingGeometry,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  TorusGeometry,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three'

type Vec = { x: number; y: number }
type Description = { coffeeWalk?: Record<string, never> }
export type CoffeeWalkConfig = MeshConfig & Description
type CoffeeWalkUpdate = MeshUpdate & Description

const COLORS = {
  sweater: '#d2543a',
  trousers: '#3d4a5c',
  skin: '#f1c7a5',
  hair: '#3a2a20',
  cup: '#fffaf2',
  sleeve: '#a0673f',
  shadow: '#2a1d14',
  guide: '#e0782f',
  door: '#7a4a2a',
  steam: '#fff4e2',
}

// Hints in reach at once, and bursts going at once
const HINTS = 6
const BURSTS = 4
const BURST_S = 1.1
const PUFFS = 8

/** ENU metres -> the frame's West-Up-North */
const place = (o: Object3D, p: Vec, up = 0) => o.position.set(-p.x, up, p.y)
/** Turns `o` (front +Z) to face `dir` (ENU) */
const face = (o: Object3D, dir: Vec) => (o.rotation.y = Math.atan2(-dir.x, dir.y))

export class CoffeeWalkMeshDesc extends MeshDesc<CoffeeWalkConfig, CoffeeWalkUpdate, Group> {
  private geometries: BufferGeometry[] = []
  private materials: Material[] = []
  private walker = new Group()
  private figure = new Group()
  private legs: Group[] = []
  private arms: Group[] = []
  private cup = new Group()
  private guide = new Group()
  private hints: Group[] = []
  private bursts: { group: Group; ring: Mesh; puffs: Mesh[]; start: number }[] = []

  constructor(...args: ConstructorParameters<typeof MeshDesc<CoffeeWalkConfig, CoffeeWalkUpdate>>) {
    super(...args)
  }

  private geometry<T extends BufferGeometry>(g: T): T {
    this.geometries.push(g)
    return g
  }

  private lambert(color: string) {
    const m = new MeshLambertMaterial({ color })
    this.materials.push(m)
    return m
  }

  /** Flat and see-through, drawn over everything when `onTop` (the hints: buildings don't hide them) */
  private basic(color: string, opacity = 1, onTop = true) {
    const m = new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, depthTest: !onTop, side: DoubleSide })
    this.materials.push(m)
    return m
  }

  override createMesh() {
    const root = new Group()

    // The walker, 1.7 tall, its front +Z; scaled up from outside to be seen from the camera
    const limb = this.geometry(new CapsuleGeometry(0.09, 0.62, 4, 8))
    const trousers = this.lambert(COLORS.trousers)
    const sweater = this.lambert(COLORS.sweater)
    const skin = this.lambert(COLORS.skin)
    for (const side of [-1, 1]) {
      const leg = new Group()
      leg.position.set(side * 0.11, 0.86, 0)
      const m = new Mesh(limb, trousers)
      m.position.y = -0.4
      leg.add(m)
      this.legs.push(leg)
      this.figure.add(leg)

      const arm = new Group()
      arm.position.set(side * 0.3, 1.38, 0)
      const a = new Mesh(this.geometry(new CapsuleGeometry(0.075, 0.5, 4, 8)), sweater)
      a.position.y = -0.3
      arm.add(a)
      const hand = new Mesh(this.geometry(new SphereGeometry(0.075, 10, 8)), skin)
      hand.position.y = -0.62
      arm.add(hand)
      this.arms.push(arm)
      this.figure.add(arm)
    }
    const body = new Mesh(this.geometry(new CapsuleGeometry(0.24, 0.42, 6, 12)), sweater)
    body.position.y = 1.16
    this.figure.add(body)
    const head = new Mesh(this.geometry(new SphereGeometry(0.2, 16, 12)), skin)
    head.position.y = 1.62
    this.figure.add(head)
    const hair = new Mesh(this.geometry(new SphereGeometry(0.215, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.55)), this.lambert(COLORS.hair))
    hair.position.set(0, 1.64, -0.02)
    hair.rotation.x = -0.25
    this.figure.add(hair)

    // A takeaway cup in the right hand, a sleeve round it
    const cupBody = new Mesh(this.geometry(new CylinderGeometry(0.075, 0.058, 0.2, 14)), this.lambert(COLORS.cup))
    const sleeve = new Mesh(this.geometry(new CylinderGeometry(0.073, 0.065, 0.08, 14)), this.lambert(COLORS.sleeve))
    const lid = new Mesh(this.geometry(new CylinderGeometry(0.08, 0.08, 0.025, 14)), this.lambert(COLORS.cup))
    lid.position.y = 0.11
    this.cup.add(cupBody, sleeve, lid)
    this.cup.position.set(0, -0.66, 0.06)
    this.cup.visible = false
    this.arms[0]!.add(this.cup)

    // Behind a building, the walker shows through it as a silhouette: a capsule round it,
    // drawn only where something is nearer the camera. (Convex, so it never hides itself; a
    // copy of the figure would show its own hair over its head)
    const ghost = new MeshBasicMaterial({ color: COLORS.sweater, transparent: true, opacity: 0.5, depthWrite: false, depthFunc: GreaterDepth })
    this.materials.push(ghost)
    const silhouette = new Mesh(this.geometry(new CapsuleGeometry(0.3, 1.05, 6, 16)), ghost)
    silhouette.position.y = 0.95
    silhouette.renderOrder = 10
    this.walker.add(silhouette)

    const shadow = new Mesh(this.geometry(new CircleGeometry(0.45, 24)), this.basic(COLORS.shadow, 0.28, false))
    shadow.rotation.x = -Math.PI / 2
    shadow.position.y = 0.02
    this.walker.add(shadow, this.figure)
    root.add(this.walker)

    // The arrow to the nearest shop: lies on the ground, just out from the feet
    const arrow = new Shape()
    arrow.moveTo(0, 0.5)
    arrow.lineTo(0.38, 0)
    arrow.lineTo(0.14, 0.04)
    arrow.lineTo(0, 0.18)
    arrow.lineTo(-0.14, 0.04)
    arrow.lineTo(-0.38, 0)
    arrow.closePath()
    const arrowMesh = new Mesh(this.geometry(new ShapeGeometry(arrow)), this.basic(COLORS.guide, 0.9))
    // The shape's +Y onto the frame's +Z (forward), flat on the ground
    arrowMesh.rotation.x = Math.PI / 2
    arrowMesh.position.set(0, 0.04, 1)
    arrowMesh.scale.setScalar(1.6)
    this.guide.add(arrowMesh)
    this.guide.visible = false
    root.add(this.guide)

    // Door hints: a ring on the street at the door and chevrons on into the shop
    const chevron = new Shape()
    chevron.moveTo(-0.5, 0)
    chevron.lineTo(0, 0.42)
    chevron.lineTo(0.5, 0)
    chevron.lineTo(0.5, 0.22)
    chevron.lineTo(0, 0.64)
    chevron.lineTo(-0.5, 0.22)
    chevron.closePath()
    const chevronGeometry = this.geometry(new ShapeGeometry(chevron))
    const ringGeometry = this.geometry(new RingGeometry(0.55, 0.75, 32))
    for (let i = 0; i < HINTS; i++) {
      const hint = new Group()
      const ring = new Mesh(ringGeometry, this.basic(COLORS.door, 0.7))
      ring.rotation.x = -Math.PI / 2
      ring.position.y = 0.05
      hint.add(ring)
      for (let k = 0; k < 3; k++) {
        const c = new Mesh(chevronGeometry, this.basic(COLORS.door, 0.8))
        c.rotation.x = Math.PI / 2
        c.position.y = 0.05
        c.name = 'chevron'
        hint.add(c)
      }
      hint.visible = false
      this.hints.push(hint)
      root.add(hint)
    }

    // Bursts: a ring of steam spreading over the street, puffs rising from it
    const puffGeometry = this.geometry(new SphereGeometry(1, 12, 8))
    const burstRing = this.geometry(new TorusGeometry(1, 0.1, 6, 48))
    for (let i = 0; i < BURSTS; i++) {
      const group = new Group()
      const ring = new Mesh(burstRing, this.basic(COLORS.guide, 1))
      ring.rotation.x = Math.PI / 2
      group.add(ring)
      const puffs: Mesh[] = []
      for (let k = 0; k < PUFFS; k++) {
        const puff = new Mesh(puffGeometry, this.basic(COLORS.steam, 0.9))
        puffs.push(puff)
        group.add(puff)
      }
      group.visible = false
      this.bursts.push({ group, ring, puffs, start: -Infinity })
      root.add(group)
    }

    // Placed by geodetic; the parts by hand every frame
    root.traverse((o) => (o.frustumCulled = false))
    return root
  }

  /**
   * Puts the walker at `p` facing `facing`, `scale` times life size, `stride` (rad) into its
   * walk cycle, `swing` (0-1) how much its limbs swing. `inside` (0-1) sinks it into a shop.
   */
  setWalker(p: Vec, facing: Vec, scale: number, stride: number, swing: number, inside = 0): void {
    place(this.walker, p)
    face(this.walker, facing)
    this.walker.scale.setScalar(scale * (1 - 0.6 * inside))
    this.walker.visible = inside < 0.99
    const a = Math.sin(stride) * 0.7 * swing
    this.legs[0]!.rotation.x = a
    this.legs[1]!.rotation.x = -a
    // The arm with the cup swings less, and holds it up
    this.arms[0]!.rotation.x = this.cup.visible ? -0.9 + a * 0.2 : -a * 0.8
    this.arms[1]!.rotation.x = a * 0.8
    this.figure.position.y = Math.abs(Math.cos(stride)) * 0.06 * swing
  }

  /** Whether the walker has a coffee in hand */
  set carrying(on: boolean) {
    this.cup.visible = on
  }

  /** Points the arrow at the walker's feet along `dir`, or hides it */
  setGuide(p: Vec, dir: Vec | null, scale: number, time: number): void {
    this.guide.visible = !!dir
    if (!dir) return
    place(this.guide, p)
    face(this.guide, dir)
    this.guide.scale.setScalar(scale * (1 + 0.08 * Math.sin(time * 5)))
  }

  /** Shows a hint at each door in `doors` (`near`: 1 at the door, 0 out of reach) */
  setHints(doors: { point: Vec; into: Vec | null; near: number }[], scale: number, time: number): void {
    this.hints.forEach((hint, i) => {
      const d = doors[i]
      hint.visible = !!d
      if (!d) return
      place(hint, d.point)
      hint.scale.setScalar(scale)
      const pulse = 0.85 + 0.15 * Math.sin(time * 6)
      const [ring, ...chevrons] = hint.children as Mesh[]
      ring!.scale.setScalar(pulse * (0.7 + 0.3 * d.near))
      ;(ring!.material as MeshBasicMaterial).opacity = 0.35 + 0.5 * d.near
      if (d.into) face(hint, d.into)
      chevrons.forEach((c, k) => {
        c.visible = !!d.into
        // Marching in, one after the other
        const t = (time * 1.4 + k / chevrons.length) % 1
        c.position.z = 0.9 + t * 1.6
        ;(c.material as MeshBasicMaterial).opacity = Math.sin(t * Math.PI) * (0.3 + 0.7 * d.near)
      })
    })
  }

  /** Starts a burst at `p` (m), `scale` times its size */
  burst(p: Vec, scale: number, time: number): void {
    const b = this.bursts.reduce((oldest, b) => (b.start < oldest.start ? b : oldest))
    b.start = time
    place(b.group, p)
    b.group.scale.setScalar(scale)
    b.puffs.forEach((puff, k) => {
      const a = (k / b.puffs.length) * Math.PI * 2 + Math.random() * 0.4
      puff.userData = { a, rise: 1.5 + Math.random() * 1.5 }
    })
  }

  /** Moves the bursts on to `time` (s) */
  tick(time: number): void {
    for (const b of this.bursts) {
      const t = (time - b.start) / BURST_S
      b.group.visible = t >= 0 && t < 1
      if (!b.group.visible) continue
      const ease = 1 - (1 - t) ** 3
      b.ring.scale.setScalar(0.5 + 2.2 * ease)
      b.ring.position.y = 0.1
      ;(b.ring.material as MeshBasicMaterial).opacity = 1 - t
      for (const puff of b.puffs) {
        const { a, rise } = puff.userData as { a: number; rise: number }
        const r = 0.6 + 1.6 * ease
        puff.position.set(Math.cos(a) * r, 0.3 + rise * ease, Math.sin(a) * r)
        puff.scale.setScalar(0.3 + 0.45 * t)
        ;(puff.material as MeshBasicMaterial).opacity = 0.9 * (1 - t)
      }
    }
  }

  override onDestroy(): void {
    super.onDestroy()
    for (const g of this.geometries) g.dispose()
    for (const m of this.materials) m.dispose()
  }
}
