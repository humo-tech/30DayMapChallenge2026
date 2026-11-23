// Day 23's ground, for Navara: each prefecture a matte slab laid on the globe, so a heap's shadow
// falls on its own prefecture and the next one reads as another piece. Three layers, from the
// bottom:
//
// - a cover over the basemap's own Japan, in the basemap's sea colour and unlit like it, so the
//   map's coast doesn't show round the thinned and rounded one here;
// - the land whole, lower down, floors the grooves between the prefectures (so a groove looks cut
//   into stone, not through to the sea);
// - the prefectures' slabs (they come shrunk from build_data.py, which leaves the grooves).
//
// Everything is made flat in Day 23's plan (km, see japanLcc.ts), its big faces cut finer, and
// every vertex then bent onto the ellipsoid, so it follows the curve of the Earth across the
// 2,000 km of Japan without the middle of a face sinking under it.
import { geodeticToVector3, MeshDesc, type MeshConfig, type MeshUpdate } from '@navaramap/three'
import {
  BufferGeometry,
  Color,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Shape,
  ShapeGeometry,
  Vector2,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Ring } from './harvestHeaps'
import { fromPlan } from './japanLcc'
import { painted, shapeOf, slab, subdivide } from './landGeometry'

type HarvestLandOptions = {
  /** Each prefecture's polygons (plan km: outer ring, then holes) */
  prefs: Ring[][][]
  color: Color
  /** How far the prefectures' shades wander from `color` (0-1) */
  variation?: number
  /** Slab thickness (m) */
  thickness?: number
  /** The land whole, flooring the grooves at `floorHeight` (m) */
  land?: Ring[][]
  floorColor?: Color
  floorHeight?: number
  /** Where to hide the basemap, and its sea colour */
  cover?: Ring[][]
  coverColor?: Color
}
type Description = { harvestLand?: HarvestLandOptions }
export type HarvestLandConfig = MeshConfig & Description
type HarvestLandUpdate = MeshUpdate & Description

const ANCHOR = { lng: 137, lat: 36, height: 0 }
// Longest edge (km) a face keeps before it's cut: a 25 km chord sags 12 m below the curve
const MAX_EDGE = 25

/** Plan (x, y) and height (z, km) -> ECEF from `anchor` (m), shading recomputed */
function bend(g: BufferGeometry, anchor: Vector3) {
  const pos = g.getAttribute('position')
  const v = new Vector3()
  for (let i = 0; i < pos.count; i++) {
    const [lng, lat] = fromPlan(pos.getX(i), pos.getY(i))
    v.copy(geodeticToVector3({ lng, lat, height: pos.getZ(i) * 1000 })).sub(anchor)
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  g.computeVertexNormals()
  g.computeBoundingSphere()
  return g
}

export class HarvestLandMeshDesc extends MeshDesc<HarvestLandConfig, HarvestLandUpdate, Group> {
  private config: HarvestLandConfig
  private meshes: Mesh[] = []

  constructor(...args: ConstructorParameters<typeof MeshDesc<HarvestLandConfig, HarvestLandUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  override createMesh() {
    const o = this.config.harvestLand!
    const { prefs, color, variation = 0.06, thickness = 5000, land, floorColor = color, floorHeight = thickness / 2, cover, coverColor } = o
    const anchor = geodeticToVector3(ANCHOR)
    const group = new Group()
    group.position.copy(anchor)
    const add = (geometry: BufferGeometry, material: MeshStandardMaterial | MeshBasicMaterial, shadows: boolean) => {
      if (material instanceof MeshStandardMaterial) this.ctx.applyShadowMaterial(material)
      const mesh = new Mesh(bend(subdivide(geometry, MAX_EDGE), anchor), material)
      mesh.receiveShadow = shadows
      this.meshes.push(mesh)
      group.add(mesh)
    }

    // A shade per prefecture, a touch lighter or darker
    const slabs = prefs.flatMap((polygons, i) => {
      const shade = color.clone().offsetHSL(0, 0, variation * (((i * 0.618) % 1) - 0.5))
      return polygons.map((rings) => slab(rings, thickness / 1000, shade))
    })
    add(mergeGeometries(slabs)!, new MeshStandardMaterial({ vertexColors: true, roughness: 0.92 }), true)
    if (land) {
      add(mergeGeometries(land.map((rings) => slab(rings, floorHeight / 1000, floorColor)))!, new MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), true)
    }
    if (cover && coverColor) {
      // Just above the map, flat and unlit like it
      const flat = cover.map((rings) => painted(new ShapeGeometry(shapeOf(rings), 1).toNonIndexed().translate(0, 0, 0.03), coverColor))
      add(mergeGeometries(flat)!, new MeshBasicMaterial({ vertexColors: true }), false)
    }
    return group
  }

  override onDestroy(): void {
    for (const m of this.meshes) {
      m.geometry.dispose()
      ;(m.material as MeshStandardMaterial).dispose()
    }
    super.onDestroy()
  }
}
