"""Day 28 (Senses: Feeling): a plain world map, to wear the colours of a face.

From Natural Earth (1:50m): the countries, each given one of four shades so no two neighbours
share one (a greedy colouring of the borders' graph, biggest countries first), with Antarctica
and Greenland apart as ice; the lakes; the rivers; the coastlines and the land borders; and the
world's largest cities (1:10m populated places). Also a graticule every 15°.

Out, in public/data/day28/:
  countries.geojson  polygons, `k` 0-3 (the shade) or 4 (ice)
  lakes.geojson      polygons
  lines.geojson      `kind`: coast | border | river | grid
  cities.geojson     points, `pop`

  scripts/.venv/bin/python scripts/day28/build_world.py
"""
import json, os, urllib.request

import shapely
from shapely.geometry import LineString, mapping, shape
from shapely.ops import unary_union

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, '../../public/data/day28')
CACHE = os.path.join(HERE, '.cache')
NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson'
os.makedirs(OUT, exist_ok=True)
os.makedirs(CACHE, exist_ok=True)

# Simplify to this (degrees) and keep this many decimals: plenty for a globe seen whole
TOLERANCE = 0.04
DECIMALS = 3
N_CITIES = 260


def natural_earth(name: str) -> list[dict]:
    """A Natural Earth layer's features (its GeoJSON edition, downloaded once)."""
    path = os.path.join(CACHE, f'{name}.geojson')
    if not os.path.exists(path):
        urllib.request.urlretrieve(f'{NE}/{name}.geojson', path)
    with open(path) as f:
        return json.load(f)['features']


def clean(g):
    g = shapely.set_precision(g.simplify(TOLERANCE, preserve_topology=True), 10 ** -DECIMALS)
    return g if not g.is_empty else None


def write(name: str, feats: list[dict]):
    with open(os.path.join(OUT, name), 'w') as f:
        json.dump({'type': 'FeatureCollection', 'features': feats}, f, separators=(',', ':'))
    print(name, len(feats), os.path.getsize(os.path.join(OUT, name)) // 1024, 'KB')


# --- Countries, four shades ---
day22 = os.path.join(HERE, '../day22/.cache/ne_50m_admin_0_countries.geojson')
src = json.load(open(day22))['features'] if os.path.exists(day22) else natural_earth('ne_50m_admin_0_countries')
countries = []
for f in src:
    g = shape(f['geometry']).buffer(0)
    p = f['properties']
    name = p.get('ADMIN') or p.get('NAME')
    countries.append({'name': name, 'geom': g, 'ice': name in ('Antarctica', 'Greenland')})
# Neighbours: touching once grown a little (a strait of a few km counts, as on a printed map)
grown = [c['geom'].buffer(0.05) for c in countries]
tree = shapely.STRtree(grown)
order = sorted(range(len(countries)), key=lambda i: -countries[i]['geom'].area)
shade = {}
for i in order:
    if countries[i]['ice']:
        continue
    used = {shade[j] for j in tree.query(grown[i], predicate='intersects') if j in shade and j != i}
    shade[i] = next(k for k in range(4) if k not in used) if len(used) < 4 else min(range(4), key=lambda k: sum(1 for j in used if j == k))
feats = []
for i, c in enumerate(countries):
    g = clean(c['geom'])
    if g:
        feats.append({'type': 'Feature', 'properties': {'k': 4 if c['ice'] else shade[i], 'name': c['name']}, 'geometry': mapping(g)})
write('countries.geojson', feats)

# --- Lakes ---
feats = []
for f in natural_earth('ne_50m_lakes'):
    g = clean(shape(f['geometry']).buffer(0))
    if g:
        feats.append({'type': 'Feature', 'properties': {}, 'geometry': mapping(g)})
write('lakes.geojson', feats)

# --- Lines: coasts, land borders, rivers, the graticule ---
lines = []
land = unary_union([c['geom'] for c in countries])
for g in getattr(land, 'geoms', [land]):
    for ring in [g.exterior, *g.interiors]:
        r = clean(LineString(ring.coords))
        if r:
            lines.append({'type': 'Feature', 'properties': {'kind': 'coast'}, 'geometry': mapping(r)})
for f in natural_earth('ne_50m_admin_0_boundary_lines_land'):
    g = clean(shape(f['geometry']))
    if g:
        lines.append({'type': 'Feature', 'properties': {'kind': 'border'}, 'geometry': mapping(g)})
for f in natural_earth('ne_50m_rivers_lake_centerlines'):
    if (f['properties'].get('scalerank') or 9) > 6:
        continue
    g = clean(shape(f['geometry']))
    if g:
        lines.append({'type': 'Feature', 'properties': {'kind': 'river'}, 'geometry': mapping(g)})
for lng in range(-180, 180, 15):
    lines.append({'type': 'Feature', 'properties': {'kind': 'grid'}, 'geometry': {'type': 'LineString', 'coordinates': [[lng, lat] for lat in range(-80, 81, 2)]}})
for lat in range(-75, 76, 15):
    lines.append({'type': 'Feature', 'properties': {'kind': 'grid'}, 'geometry': {'type': 'LineString', 'coordinates': [[lng, lat] for lng in range(-180, 181, 2)]}})
write('lines.geojson', lines)

# --- Cities: the biggest ---
places = json.load(open(os.path.join(HERE, '../day22/.cache/ne_10m_populated_places_simple.geojson')))['features']
places.sort(key=lambda f: -(f['properties'].get('pop_max') or 0))
feats = [
    {
        'type': 'Feature',
        'properties': {'pop': f['properties'].get('pop_max') or 0, 'name': f['properties'].get('name')},
        'geometry': {'type': 'Point', 'coordinates': [round(c, 3) for c in f['geometry']['coordinates']]},
    }
    for f in places[:N_CITIES]
]
write('cities.geojson', feats)
