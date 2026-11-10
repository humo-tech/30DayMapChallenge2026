// Day 8's giant teddy bears, sitting in Harajuku's parks: a MapLibre custom layer drawing a
// Three.js scene into the map's own GL context. A bear sits in each of the bigger parks of
// Overture's land use as their tiles load, and turns to watch the camera go round
import type { CustomLayerInterface, Map as MapLibreMap, MapGeoJSONFeature } from 'maplibre-gl'
import { MercatorCoordinate } from 'maplibre-gl'
import {
  Camera,
  Color,
  DirectionalLight,
  type Group,
  HemisphereLight,
  Matrix4,
  MeshPhysicalMaterial,
  NeutralToneMapping,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three'
import { disposeTree, feltTexture, makeBear, rng } from './utopiaWorld'

// Bears within RADIUS_M of the centre, at most MAX_BEARS, at least SPACING_M apart
const RADIUS_M = 1200
const MAX_BEARS = 12
const SPACING_M = 150
// The green places a bear may sit in (Overture land use subtypes), and how big (m²) they must be
const PARKS = new Set(['park', 'horticulture', 'recreation'])
const MIN_AREA = 1500
// makeBear() is about 3.6 units tall: giants 20-40 m tall, bigger in the bigger parks
const BEAR_UNITS = 3.6
const BEAR_M = { min: 20, max: 40 }
// A shade deeper than Day 8's pastels, to stand out on the green
const BEAR_COLORS = ['#ff9fb8', '#ffbf8f', '#c4adff', '#ffe47a', '#8fc8ff', '#e9c3a3']

const hash = (s: string) => {
  let h = 2166136261
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return h >>> 0
}

// Area (m²) and area centroid of a ring in local metres
function ringCentroid(ring: [number, number][]) {
  let a = 0
  let cx = 0
  let cy = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x0, y0] = ring[j]!
    const [x1, y1] = ring[i]!
    const f = x0 * y1 - x1 * y0
    a += f
    cx += (x0 + x1) * f
    cy += (y0 + y1) * f
  }
  return a === 0 ? undefined : { area: Math.abs(a / 2), x: cx / (3 * a), y: cy / (3 * a) }
}

function inside(ring: [number, number][], x: number, y: number) {
  let hit = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!
    const [xj, yj] = ring[j]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

export function parkBears(centre: [number, number]): CustomLayerInterface & { dispose(): void } {
  const origin = MercatorCoordinate.fromLngLat(centre, 0)
  const unit = origin.meterInMercatorCoordinateUnits()
  // Scene frame: x east, y up, z south, in metres from the centre (as Day 8's: bears face +z)
  const toLocal = (lng: number, lat: number): [number, number] => {
    const m = MercatorCoordinate.fromLngLat([lng, lat], 0)
    return [(m.x - origin.x) / unit, (m.y - origin.y) / unit]
  }
  const model = new Matrix4().makeTranslation(origin.x, origin.y, origin.z).scale(new Vector3(unit, -unit, unit)).multiply(new Matrix4().makeRotationX(Math.PI / 2))

  const scene = new Scene()
  const camera = new Camera()
  // Day 8's light: a soft pink-white sky over lilac ground, and a warm sun from the south-west
  scene.add(new HemisphereLight('#fff0f4', '#e6dcff', 1.6))
  const sun = new DirectionalLight('#fff3e2', 2.0)
  sun.position.set(-0.5, 0.75, 0.45)
  scene.add(sun)

  const felt = feltTexture(rng(7))
  const plush = (color: string) =>
    new MeshPhysicalMaterial({
      color,
      roughness: 0.92,
      sheen: 1,
      sheenRoughness: 0.55,
      sheenColor: new Color('#ffffff'),
      bumpMap: felt,
      bumpScale: 1.2,
    })

  type Bear = { id: string; x: number; z: number; group: Group; phase: number }
  const bears: Bear[] = []
  const taken = new Set<string>()

  let map: MapLibreMap | undefined
  let renderer: WebGLRenderer | undefined
  // Tiles keep arriving while the camera circles (the map is never idle): look for parks at most
  // every SEAT_MS
  const SEAT_MS = 600
  let seatTimer: ReturnType<typeof setTimeout> | undefined
  const onData = (e: { sourceId?: string }) => {
    if (e.sourceId !== 'base' || seatTimer !== undefined || bears.length >= MAX_BEARS) return
    seatTimer = setTimeout(() => {
      seatTimer = undefined
      seat()
    }, SEAT_MS)
  }

  // Seat bears in the parks in the loaded tiles. Once seated a bear stays, so only the ones still
  // missing are looked for, in a fixed order (by id hash) so every visit gets the same bears
  const seat = () => {
    if (!map || bears.length >= MAX_BEARS) return
    const features = map.querySourceFeatures('base', { sourceLayer: 'land_use' }) as MapGeoJSONFeature[]
    const parks: { id: string; x: number; z: number; area: number }[] = []
    for (const f of features) {
      const id = String(f.properties['id'] ?? '')
      if (!id || taken.has(id) || !PARKS.has(String(f.properties['subtype']))) continue
      const g = f.geometry
      const outer = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0]?.[0] : undefined
      if (!outer) continue
      const ring = outer.map(([lng, lat]) => toLocal(lng!, lat!))
      const c = ringCentroid(ring)
      if (!c || c.area < MIN_AREA || Math.hypot(c.x, c.y) > RADIUS_M || !inside(ring, c.x, c.y)) continue
      parks.push({ id, x: c.x, z: c.y, area: c.area })
    }
    // (a park cut by a tile edge comes once per tile: keep its biggest piece)
    const best = new Map<string, (typeof parks)[number]>()
    for (const r of parks) if ((best.get(r.id)?.area ?? 0) < r.area) best.set(r.id, r)
    const order = [...best.values()].sort((a, b) => hash(a.id) - hash(b.id))
    for (const r of order) {
      if (bears.length >= MAX_BEARS) break
      if (bears.some((b) => Math.hypot(b.x - r.x, b.z - r.z) < SPACING_M)) continue
      const metres = Math.min(BEAR_M.max, Math.max(BEAR_M.min, Math.sqrt(r.area) * 0.25))
      const group = makeBear(plush, BEAR_COLORS[hash(r.id) % BEAR_COLORS.length]!)
      group.scale.setScalar(metres / BEAR_UNITS)
      // Sink it a little, so it sits in the grass rather than on it
      group.position.set(r.x, -0.04 * metres, r.z)
      scene.add(group)
      bears.push({ id: r.id, x: r.x, z: r.z, group, phase: (hash(r.id) % 1000) / 160 })
      taken.add(r.id)
    }
    map.triggerRepaint()
  }

  return {
    id: 'park-bears',
    type: 'custom',
    renderingMode: '3d',
    onAdd(m, gl) {
      map = m
      renderer = new WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true })
      renderer.autoClear = false
      renderer.toneMapping = NeutralToneMapping
      m.on('sourcedata', onData)
    },
    render(_gl, { defaultProjectionData }) {
      if (!map || !renderer) return
      const t = performance.now() / 1000
      // Where the camera stands, in the scene's frame: every bear turns its whole body to it.
      // MapLibre puts the eye 1.5 viewport heights (fov 36.87°) from the centre, along the pitch
      const c = map.getCenter()
      const [cx, cz] = toLocal(c.lng, c.lat)
      const metresPerPx = (78271.517 * Math.cos((c.lat * Math.PI) / 180)) / 2 ** map.getZoom()
      const behind = 1.5 * map.getCanvas().clientHeight * metresPerPx * Math.sin((map.getPitch() * Math.PI) / 180)
      const b = (map.getBearing() * Math.PI) / 180
      const ex = cx - behind * Math.sin(b)
      const ez = cz + behind * Math.cos(b)
      for (const bear of bears) {
        bear.group.rotation.y = Math.atan2(ex - bear.x, ez - bear.z)
        // Day 8's slow sway and little nod
        const upper = bear.group.children[0]!
        upper.rotation.z = Math.sin(t * 0.7 + bear.phase) * 0.05
        upper.rotation.x = Math.sin(t * 0.45 + bear.phase * 1.3) * 0.04
      }
      camera.projectionMatrix.fromArray(defaultProjectionData.mainMatrix as unknown as number[]).multiply(model)
      renderer.resetState()
      renderer.render(scene, camera)
      // Keep drawing, so the bears sway even when the camera stops
      map.triggerRepaint()
    },
    onRemove() {
      clearTimeout(seatTimer)
      map?.off('sourcedata', onData)
      map = undefined
    },
    dispose() {
      for (const b of bears) disposeTree(b.group)
      felt.dispose()
      renderer?.dispose()
      renderer = undefined
    },
  }
}
