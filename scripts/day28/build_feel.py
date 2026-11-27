"""Day 28 (Senses: Feeling): what the ground under your finger is made of.

One grid over Hokkaido and the southern Sea of Okhotsk on 1 March 2025, when
the drift ice was at its fullest and the island lay clear under snow, read
straight from the cloud (nothing to keep on disk):

- the MODIS Terra true-colour image of that day (NASA GIBS, z9 ≈ 300 m),
  which shows where the drift ice is: bright pixels on the sea
- ESA WorldCover 2021 (10 m, read at its 80 m overview): forests, towns, lakes
- Copernicus DEM GLO-90: the height, for the slopes

Out: public/data/day28/feel.png, RGB on a 0.005° lng/lat grid (north up; no alpha, which a
browser canvas would premultiply into the other channels)
  R  material  (0 sea, 1 drift ice, 2 snowfield, 3 forest, 4 town, 5 frozen lake)
  G  how much of it: ice cover on the sea, the built-up share in a town, 0-255
  B  height in steps of 9 m (Hokkaido's highest, Asahidake, is 2,291 m)
and feel.json with the grid's extent and the material names.

  scripts/.venv/bin/python scripts/day28/build_feel.py
"""
import io, json, math, os, time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import rasterio
from PIL import Image
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject

W_, E_, S_, N_ = 139.0, 147.0, 41.0, 46.5
RES = 0.005
NX, NY = round((E_ - W_) / RES), round((N_ - S_) / RES)
DST = from_origin(W_, N_, RES, RES)
DATE = '2025-03-01'
OUT = os.path.join(os.path.dirname(__file__), '../../public/data/day28')
MATERIALS = ['sea', 'ice', 'snow', 'forest', 'town', 'lake']
SEA, ICE, SNOW, FOREST, TOWN, LAKE = range(6)

ENV = dict(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif', GDAL_HTTP_MAX_RETRY='3')


def into(src, src_transform, src_crs, resampling, nodata=None) -> np.ndarray:
    """One source array onto the grid (NaN where it has no data)."""
    dst = np.full((NY, NX), np.nan, np.float32)
    reproject(src.astype(np.float32), dst, src_transform=src_transform, src_crs=src_crs, src_nodata=nodata,
              dst_transform=DST, dst_crs='EPSG:4326', dst_nodata=np.nan, resampling=resampling)
    return dst


def merge(parts: list[np.ndarray]) -> np.ndarray:
    out = np.full((NY, NX), np.nan, np.float32)
    for p in parts:
        ok = ~np.isnan(p)
        out[ok] = p[ok]
    return out


def open_cog(url: str, overview: int | None = None):
    try:
        return rasterio.open('/vsicurl/' + url, overview_level=overview) if overview is not None else rasterio.open('/vsicurl/' + url)
    except rasterio.errors.RasterioIOError:
        return None  # a tile of open sea: not published


# --- MODIS: the z9 web-mercator tiles, stitched and warped ---
Z = 9
def tile_x(lng): return int((lng + 180) / 360 * 2 ** Z)
def tile_y(lat):
    r = math.radians(lat)
    return int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** Z)

xs = range(tile_x(W_), tile_x(E_) + 1)
ys = range(tile_y(N_), tile_y(S_) + 1)

def fetch(xy):
    x, y = xy
    url = (f'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/{DATE}'
           f'/GoogleMapsCompatible_Level9/{Z}/{y}/{x}.jpg')
    for attempt in range(5):  # GIBS now and then answers 502, or not at all
        try:
            return xy, np.asarray(Image.open(io.BytesIO(urllib.request.urlopen(url, timeout=60).read())).convert('RGB'))
        except OSError:
            if attempt == 4:
                raise
            time.sleep(2 ** attempt)

mosaic = np.zeros((len(ys) * 256, len(xs) * 256, 3), np.uint8)
with ThreadPoolExecutor(16) as ex:
    for (x, y), im in ex.map(fetch, [(x, y) for x in xs for y in ys]):
        mosaic[(y - ys[0]) * 256:(y - ys[0] + 1) * 256, (x - xs[0]) * 256:(x - xs[0] + 1) * 256] = im
HALF = 20037508.342789244
px = 2 * HALF / 2 ** Z / 256
merc = from_origin(-HALF + xs[0] * 256 * px, HALF - ys[0] * 256 * px, px, px)
rgb = np.stack([into(mosaic[..., c], merc, 'EPSG:3857', Resampling.bilinear) for c in range(3)]) / 255
print('modis', mosaic.shape)

with rasterio.Env(**ENV):
    # --- WorldCover: the class by mode, and the built-up share by average ---
    covers, builts = [], []
    for la in (39, 42, 45):
        for lo in (138, 141, 144):
            ds = open_cog(f'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N{la:02d}E{lo:03d}_Map.tif', 2)
            if ds is None:
                continue
            with ds:
                a = ds.read(1)
                covers.append(into(a, ds.transform, ds.crs, Resampling.mode, nodata=0))
                b = np.where(a == 0, np.nan, (a == 50).astype(np.float32))
                builts.append(into(b, ds.transform, ds.crs, Resampling.average, nodata=np.nan))
            print('worldcover', la, lo)
    cover = merge(covers)
    built = merge(builts)

    # --- Copernicus DEM ---
    def dem(lalo):
        la, lo = lalo
        name = f'Copernicus_DSM_COG_30_N{la:02d}_00_E{lo:03d}_00_DEM'
        ds = open_cog(f'https://copernicus-dem-90m.s3.amazonaws.com/{name}/{name}.tif')
        if ds is None:
            return None
        with ds:
            return into(ds.read(1), ds.transform, ds.crs, Resampling.average)
    with ThreadPoolExecutor(8) as ex:
        heights = [h for h in ex.map(dem, [(la, lo) for la in range(41, 47) for lo in range(139, 147)]) if h is not None]
    height = np.nan_to_num(merge(heights), nan=0)
    print('dem', len(heights), 'tiles')

np.savez_compressed('/tmp/day28/arrays.npz', cover=cover, built=built, height=height, rgb=rgb)

# --- Materials ---
# Land is what WorldCover calls land; open water inside it (class 80 away from the coast) is a lake
land = ~np.isnan(cover) & (cover != 80)
water = ~land
from scipy import ndimage
sea_label, _ = ndimage.label(water)
# The sea is the water body that touches the grid's edge; the rest are lakes (frozen in March)
edge = np.unique(np.concatenate([sea_label[0], sea_label[-1], sea_label[:, 0], sea_label[:, -1]]))
sea = np.isin(sea_label, edge[edge > 0])

mat = np.full((NY, NX), SNOW, np.uint8)
amount = np.zeros((NY, NX), np.float32)
mat[land & (cover == 10)] = FOREST
town = land & (built > 0.12)
mat[town] = TOWN
amount[town] = np.clip(built[town], 0, 1)
mat[water & ~sea] = LAKE

# Ice on the sea: the bright pixels, but only in the Sea of Okhotsk and the Nemuro Strait, and not
# under the band of thin cloud that crosses off Cape Soya (as bright as thin ice in true colour)
lum = rgb.mean(axis=0)
lngs = W_ + (np.arange(NX) + 0.5) * RES
lats = N_ - (np.arange(NY) + 0.5) * RES
LNG, LAT = np.meshgrid(lngs, lats)
# (the Sea of Okhotsk: north of Hokkaido's Pacific coast, east of Cape Soya, and west of the Pacific
# beyond Kunashir)
okhotsk = (LAT > 43.42) & (LNG > 141.9)
okhotsk &= ~((LNG > 145.75) & (LAT < 44.5))
okhotsk &= ~((LAT > 45.15) & (LAT < 45.95) & (LNG < 143.3))
ice_amount = np.clip((lum - 0.18) / 0.45, 0, 1)
ice = sea & okhotsk & (ice_amount > 0.25)
mat[sea] = SEA
mat[ice] = ICE
amount[sea] = np.where(okhotsk[sea], ice_amount[sea], 0)

H_STEP = 9
png = np.stack([mat, np.round(amount * 255).astype(np.uint8), np.clip(np.round(height / H_STEP), 0, 255).astype(np.uint8)], -1)
os.makedirs(OUT, exist_ok=True)
Image.fromarray(png, 'RGB').save(os.path.join(OUT, 'feel.png'), optimize=True)
with open(os.path.join(OUT, 'feel.json'), 'w') as f:
    json.dump({'west': W_, 'east': E_, 'south': S_, 'north': N_, 'width': NX, 'height': NY, 'date': DATE,
               'materials': MATERIALS, 'heightStep': H_STEP}, f, indent=1)
for i, m in enumerate(MATERIALS):
    print(m, int((mat == i).sum()))
