// Day 23's heaps of fruit on the globe, for Navara: one instanced draw per kind of fruit, lit by
// the sun with its cascaded shadows (so heaps shade themselves and throw long shadows across the
// land), in physical materials (glossy apples and chestnuts, matte pears).
//
// `show()` drops a set of heaps in, each piece falling along its local vertical and landing
// with a little squash, the bottom of each heap first; `leave()` shrinks them away from the top.
// Pieces are placed in Day 23's plan (km, see japanLcc.ts) and stood on the ellipsoid there: x
// east, y up, z south in each one's own frame.
import { geodeticSurfaceNormal, geodeticToVector3, MeshDesc, type MeshConfig, type MeshUpdate } from '@navaramap/three'
import { DynamicDrawUsage, Group, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three'
import { FRUIT_KEYS, type Fruit, type FruitKey } from './harvestFruits'
import type { Placement } from './harvestHeaps'
import { fromPlan } from './japanLcc'

type HarvestHeapsOptions = {
  /** The models (makeFruits()) */
  fruits: Record<FruitKey, Fruit>
  /** Most pieces of each kind shown at once */
  capacity: Record<FruitKey, number>
  /** Size of a piece: m per model unit */
  size: number
  /** Height (m) the heaps' heights are measured from: the top of the slabs they sit on */
  base?: number
  /** How far a piece falls (m), and for how long (s) */
  fall?: number
  fallSeconds?: number
  leaveSeconds?: number
}
type Description = { harvestHeaps?: HarvestHeapsOptions }
export type HarvestHeapsConfig = MeshConfig & Description
type HarvestHeapsUpdate = MeshUpdate & Description

// Where the instance offsets are measured from, for float precision: the middle of Japan
const ANCHOR = { lng: 137, lat: 36, height: 0 }

type Pose = { pos: Vector3; up: Vector3; rot: Quaternion; scale: number; delay: number; mesh: InstancedMesh; index: number }

export class HarvestHeapsMeshDesc extends MeshDesc<HarvestHeapsConfig, HarvestHeapsUpdate, Group> {
  private config: HarvestHeapsConfig
  private anchor = new Vector3()
  private meshes = {} as Record<FruitKey, InstancedMesh>
  private poses: Pose[] = []
  private phase: 'drop' | 'leave' | 'still' = 'still'
  private startedAt = 0
  private last = 0

  constructor(...args: ConstructorParameters<typeof MeshDesc<HarvestHeapsConfig, HarvestHeapsUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  private get options() {
    return { base: 0, fall: 260_000, fallSeconds: 0.55, leaveSeconds: 0.5, ...this.config.harvestHeaps! }
  }

  override createMesh() {
    this.anchor.copy(geodeticToVector3(ANCHOR))
    const { fruits } = this.options
    const group = new Group()
    group.position.copy(this.anchor)
    for (const k of FRUIT_KEYS) {
      const f = fruits[k]
      // Standard rather than physical (no clearcoat pass): the glossy ones just get less roughness
      const material = new MeshStandardMaterial({ vertexColors: true, roughness: f.roughness * (1 - 0.5 * f.clearcoat) })
      this.ctx.applyShadowMaterial(material)
      const mesh = new InstancedMesh(f.geometry, material, Math.max(1, this.options.capacity[k]))
      mesh.instanceMatrix.setUsage(DynamicDrawUsage)
      mesh.castShadow = mesh.receiveShadow = true
      mesh.frustumCulled = false
      mesh.count = 0
      this.meshes[k] = mesh
      group.add(mesh)
    }
    return group
  }

  /** Drops `placements` in (started by the next `tick`); `now` in s */
  show(placements: Placement[]): void {
    const { size, base } = this.options
    const used = Object.fromEntries(FRUIT_KEYS.map((k) => [k, 0])) as Record<FruitKey, number>
    const east = new Vector3()
    const north = new Vector3()
    const frame = new Matrix4()
    const yaw = new Quaternion()
    const tilt = new Quaternion()
    const Y = new Vector3(0, 1, 0)
    this.poses = placements.map((p) => {
      const [lng, lat] = fromPlan(p.x, p.y)
      const ground = { lng, lat, height: 0 }
      const up = geodeticSurfaceNormal(ground)
      east.set(-Math.sin((lng * Math.PI) / 180), Math.cos((lng * Math.PI) / 180), 0)
      north.crossVectors(up, east)
      // The piece's frame: x east, y up, z south
      frame.makeBasis(east, up, north.clone().negate())
      const rot = new Quaternion().setFromRotationMatrix(frame)
      yaw.setFromAxisAngle(Y, p.yaw)
      tilt.setFromAxisAngle(new Vector3(Math.cos(p.tiltDir), 0, Math.sin(p.tiltDir)), p.tilt)
      rot.multiply(tilt).multiply(yaw)
      const pos = geodeticToVector3(ground).sub(this.anchor).addScaledVector(up, base + p.h * 1000)
      const mesh = this.meshes[p.key]
      return { pos, up, rot, scale: p.scale * size, delay: p.delay, mesh, index: used[p.key]++ }
    })
    for (const k of FRUIT_KEYS) this.meshes[k].count = used[k]
    this.phase = 'drop'
    this.startedAt = -1
  }

  /** Shrinks the pieces showing away, the tops of the heaps first */
  leave(): void {
    this.phase = 'leave'
    this.startedAt = -1
  }

  /** Whether the pieces are still on the move */
  get busy(): boolean {
    return this.phase !== 'still'
  }

  /** Advances the drop or the leaving to `now` (s) */
  tick(now: number): void {
    if (this.phase === 'still') return
    if (this.startedAt < 0) this.startedAt = now
    const t = now - this.startedAt
    const { fall, fallSeconds, leaveSeconds } = this.options
    const m = new Matrix4()
    const v = new Vector3()
    const s = new Vector3()
    this.last = 0
    for (const x of this.poses) {
      let drop = 0
      let k = 1
      let squash = 0
      if (this.phase === 'drop') {
        const u = (t - x.delay) / fallSeconds
        if (u < 0) k = 0
        else if (u < 1) drop = fall * (1 - u * u)
        else squash = Math.max(0, 1 - (u - 1) * 4) * Math.sin((u - 1) * 4 * Math.PI) * 0.12
        this.last = Math.max(this.last, x.delay)
      } else {
        k = 1 - Math.min(1, Math.max(0, (t - (1 - x.delay / 3) * 0.25) / (leaveSeconds * 0.5)))
      }
      v.copy(x.pos).addScaledVector(x.up, drop)
      const sc = x.scale * k
      s.set(sc * (1 + squash * 0.5), sc * (1 - squash), sc * (1 + squash * 0.5))
      m.compose(v, x.rot, s)
      x.mesh.setMatrixAt(x.index, m)
    }
    for (const k of FRUIT_KEYS) this.meshes[k].instanceMatrix.needsUpdate = true
    if (this.phase === 'drop' && t > this.last + fallSeconds + 0.3) this.phase = 'still'
    if (this.phase === 'leave' && t > leaveSeconds) {
      for (const k of FRUIT_KEYS) this.meshes[k].count = 0
      this.phase = 'still'
    }
    this.emit('needsUpdate')
  }

  override onDestroy(): void {
    for (const mesh of Object.values(this.meshes)) {
      mesh.geometry.dispose()
      ;(mesh.material as MeshStandardMaterial).dispose()
    }
    super.onDestroy()
  }
}
