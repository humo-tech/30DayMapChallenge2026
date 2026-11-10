// A pastel plush style for Overture Maps' PMTiles (base, transportation, buildings), after
// Day 8's plush world: the ground a patchwork of felt with white stitches, roads of lavender
// fabric piped in pink with a lemon stitch down the middle, candy-striped rails, lollipop trees
// and buildings in sweets, under a pink-to-blue sky
import type { ExpressionSpecification, StyleSpecification } from 'maplibre-gl'

const RELEASE = '2026-10-21.0'
const TILES = `https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/${RELEASE}`

// Day 8's pastels
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
const GROUND = '#c8ecbc'
const STITCH = '#ffffff'
const INK = '#8a6aa8'

// Overture's low-zoom tiles carry the whole world, a few MB each: the sources start at z12, the
// map at z13, so only the town's tiles are read
const SOURCE_MIN = 12
export const MIN_ZOOM = 13

// "Random" per feature but stable as tiles come and go: the first hex digit of its Overture id
const byId = (colors: string[]): ExpressionSpecification => [
  'match',
  ['slice', ['to-string', ['get', 'id']], 0, 1],
  ...'0123456789abcdef'.split('').flatMap((d, i) => [d, colors[i % colors.length]!]),
  colors[0]!,
] as unknown as ExpressionSpecification

// Land use as patchwork: greens for the green places, a sweet for each kind of town
const LAND_USE: [string, string][] = [
  ['park', '#a8e8bd'],
  ['recreation', '#c2eeaa'],
  ['horticulture', '#9fe0c8'],
  ['managed', '#b4e6cc'],
  ['agriculture', '#d2f2b0'],
  ['cemetery', PASTELS.lavender],
  ['residential', '#fbe8c8'],
  ['developed', PASTELS.lilac],
  ['education', PASTELS.lemon],
  ['medical', '#ffd0d8'],
  ['religious', PASTELS.peach],
  ['pedestrian', '#ffd6e2'],
  ['transportation', '#e4dcf6'],
  ['construction', '#fbe8a2'],
  ['military', '#d6e4c6'],
]
const LAND: [string, string][] = [
  ['forest', '#9fe0c8'],
  ['grass', PASTELS.mint],
  ['shrub', '#a8e8bd'],
  ['wetland', '#bfe6ee'],
  ['sand', '#fff0c4'],
]
const matchSubtype = (pairs: [string, string][]): ExpressionSpecification =>
  ['match', ['get', 'subtype'], ...pairs.flat(), 'transparent'] as unknown as ExpressionSpecification

// Road widths (px at z16, doubling per zoom) by class
const ROAD_W: [string, number][] = [
  ['motorway', 14],
  ['trunk', 13],
  ['primary', 12],
  ['secondary', 10],
  ['tertiary', 9],
  ['residential', 7],
  ['unclassified', 7],
  ['living_street', 6],
  ['service', 4.5],
]
const roadWidth = (extra = 0, scale = 1): ExpressionSpecification => {
  const at = (z: number, f: number) =>
    ['match', ['get', 'class'], ...ROAD_W.flatMap(([c, w]) => [c, (w * scale + extra) * f]), (3.5 * scale + extra) * f] as unknown as ExpressionSpecification
  return ['interpolate', ['exponential', 2], ['zoom'], 13, at(13, 0.125), 16, at(16, 1), 19, at(19, 8)]
}
const isRoad: ExpressionSpecification = ['==', ['get', 'subtype'], 'road']
const isMajor: ExpressionSpecification = ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary']]]
const isRail: ExpressionSpecification = ['==', ['get', 'subtype'], 'rail']
// Overture's tiles drop a segment's tags below z14: those draw as small roads
const isRoadish: ExpressionSpecification = ['any', isRoad, ['!', ['has', 'subtype']]]

// Buildings: Overture's height, else its floors, else a little house
const buildingHeight: ExpressionSpecification = [
  'coalesce',
  ['get', 'height'],
  ['*', ['get', 'num_floors'], 3.2],
  8,
]

export function plushStyle(): StyleSpecification {
  const vector = (name: string, maxzoom: number) => ({
    type: 'vector' as const,
    url: `pmtiles://${TILES}/${name}.pmtiles`,
    minzoom: SOURCE_MIN,
    maxzoom,
    attribution: '© <a href="https://overturemaps.org/">Overture Maps Foundation</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors and others',
  })
  return {
    version: 8,
    glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    sources: {
      base: vector('base', 13),
      transportation: vector('transportation', 14),
      buildings: vector('buildings', 14),
    },
    sky: {
      'sky-color': '#9fd0ff',
      'horizon-color': '#ffe4ee',
      'fog-color': '#ffe4ee',
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.6,
      'fog-ground-blend': 0.4,
    },
    light: { anchor: 'viewport', color: '#fff3e2', intensity: 0.35, position: [1.4, 210, 40] },
    layers: [
      { id: 'ground', type: 'background', paint: { 'background-color': GROUND } },

      // Felt patches, each sewn on with a white running stitch
      {
        id: 'land',
        type: 'fill',
        source: 'base',
        'source-layer': 'land',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': matchSubtype(LAND) },
      },
      {
        id: 'land-use',
        type: 'fill',
        source: 'base',
        'source-layer': 'land_use',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': matchSubtype(LAND_USE) },
      },
      {
        id: 'land-use-stitch',
        type: 'line',
        source: 'base',
        'source-layer': 'land_use',
        filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['in', ['get', 'subtype'], ['literal', LAND_USE.map(([s]) => s)]]],
        paint: {
          'line-color': STITCH,
          'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.8, 18, 2.2],
          'line-dasharray': [2, 2],
          'line-offset': ['interpolate', ['linear'], ['zoom'], 14, 1, 18, 4],
          'line-opacity': 0.9,
        },
      },

      // Water: sky-blue satin with a stitched hem
      {
        id: 'water',
        type: 'fill',
        source: 'base',
        'source-layer': 'water',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': PASTELS.sky },
      },
      {
        id: 'water-stitch',
        type: 'line',
        source: 'base',
        'source-layer': 'water',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'line-color': STITCH, 'line-width': 1.4, 'line-dasharray': [2, 2], 'line-offset': 3 },
      },
      {
        id: 'waterway',
        type: 'line',
        source: 'base',
        'source-layer': 'water',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': PASTELS.sky, 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1.5, 18, 8] },
      },

      // Roads: pink piping, lavender fabric, white stitches along both edges and a lemon one
      // down the middle of the big roads
      {
        id: 'road-piping',
        type: 'line',
        source: 'transportation',
        'source-layer': 'segment',
        filter: isRoadish,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': PASTELS.pink, 'line-width': roadWidth(1.2, 1) },
      },
      {
        id: 'road',
        type: 'line',
        source: 'transportation',
        'source-layer': 'segment',
        filter: isRoadish,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#d9c2ff', 'line-width': roadWidth(0, 0.82) },
      },
      ...([-1, 1] as const).map((side) => ({
        id: `road-edge-stitch-${side < 0 ? 'left' : 'right'}`,
        type: 'line' as const,
        source: 'transportation',
        'source-layer': 'segment',
        filter: ['all', isRoad, isMajor] as unknown as ExpressionSpecification,
        minzoom: 15,
        paint: {
          'line-color': STITCH,
          'line-width': ['interpolate', ['linear'], ['zoom'], 15, 0.8, 18, 2] as unknown as ExpressionSpecification,
          'line-dasharray': [2, 2],
          'line-offset': roadWidth(0, side * 0.3),
        },
      })),
      {
        id: 'road-centre-stitch',
        type: 'line',
        source: 'transportation',
        'source-layer': 'segment',
        filter: ['all', isRoad, isMajor],
        minzoom: 14,
        paint: {
          'line-color': '#fff6b8',
          'line-width': ['interpolate', ['linear'], ['zoom'], 14, 1, 18, 4],
          'line-dasharray': [3, 2],
        },
      },

      // Rails: candy stripes
      {
        id: 'rail',
        type: 'line',
        source: 'transportation',
        'source-layer': 'segment',
        filter: isRail,
        paint: { 'line-color': '#ff9fb6', 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 2, 18, 10] },
      },
      {
        id: 'rail-stripes',
        type: 'line',
        source: 'transportation',
        'source-layer': 'segment',
        filter: isRail,
        paint: {
          'line-color': STITCH,
          'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1.4, 18, 7],
          'line-dasharray': [1, 1],
        },
      },

      // Lollipop trees, where single trees are mapped
      {
        id: 'trees',
        type: 'circle',
        source: 'base',
        'source-layer': 'land',
        filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'subtype'], 'tree']],
        minzoom: 15,
        paint: {
          'circle-color': byId(['#ff9fb6', PASTELS.mint, '#c8f2b4', PASTELS.lilac, PASTELS.lemon, PASTELS.peach]),
          'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 15, 2, 19, 20],
          'circle-stroke-color': STITCH,
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 15, 0.6, 19, 3],
          'circle-pitch-alignment': 'map',
        },
      },

      // Buildings in sweets
      {
        id: 'buildings',
        type: 'fill-extrusion',
        source: 'buildings',
        'source-layer': 'building',
        filter: ['!=', ['get', 'is_underground'], true],
        paint: {
          'fill-extrusion-color': byId([PASTELS.pink, PASTELS.peach, PASTELS.lemon, PASTELS.sky, PASTELS.lavender, PASTELS.lilac, PASTELS.cream, PASTELS.mint]),
          'fill-extrusion-height': buildingHeight,
          'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
          'fill-extrusion-opacity': 0.96,
          'fill-extrusion-vertical-gradient': true,
        },
      },

      // Park names, embroidered
      {
        id: 'park-labels',
        type: 'symbol',
        source: 'base',
        'source-layer': 'land_use',
        filter: ['all', ['has', '@name'], ['in', ['get', 'subtype'], ['literal', ['park', 'recreation', 'horticulture', 'cemetery']]]],
        minzoom: 14,
        layout: {
          'text-field': ['get', '@name'],
          'text-font': ['Noto Sans Medium'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 14, 11, 18, 16],
          'text-max-width': 8,
        },
        paint: { 'text-color': INK, 'text-halo-color': STITCH, 'text-halo-width': 2 },
      },
    ],
  }
}
