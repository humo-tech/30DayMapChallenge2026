"""Day 27 (New Tool): Typhoon Champi's day at its strongest, rendered to a video.

Not a web map: the clouds, the sea and the air are raymarched in an OpenGL
fragment shader (ModernGL, no window), frame by frame, and each frame is piped
as raw pixels into ffmpeg (bundled with imageio-ffmpeg) -> an H.264 MP4. With
no frame budget to keep, each frame can afford what the browser couldn't: the
scans at full resolution, hundreds of steps through the cloud. What doesn't
change from step to step is baked once a frame (shaders/common.glsl): the
clouds at each place, and the light through them; about 1 s a frame at
1920 x 1080 on an M2.

What it reads:
- scripts/.cache/day27/b13.npz (fetch_himawari.py): Himawari-9's infrared every
  10 minutes at 0.03° round the storm. Between two scans the frames follow the
  optical flow from one to the next (OpenCV's Farneback), not a crossfade.
- public/data/day26/clouds-NN.webp, champi.json: Day 26's hourly 0.125° scans,
  for the clouds beyond (to the horizon), and Champi's track.
- scripts/.cache/day26/winds/: ECMWF's 850 and 200 hPa winds (Day 26's
  fetch_winds.py), on which the clouds' finer detail drifts.

The sun is held where it was at one moment (SUN_AT), as on Day 26: the hours
run on (from 20:30 UTC on the 19th, dawn at the storm, to 09:30 on the 20th),
the light doesn't. The camera goes along with the storm, high and far back.

Usage:
    python scripts/day27/render.py                      # -> public/data/day27/champi.mp4
    python scripts/day27/render.py --still 03:00        # one frame (UTC) -> a PNG to look at
    python scripts/day27/render.py --width 960 --height 540 --out /tmp/draft.mp4
    python scripts/day27/render.py --no-clouds          # -> public/data/day27/champi-noclouds.mp4
"""

import argparse
import datetime as dt
import json
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

import cv2
import imageio_ffmpeg
import moderngl
import numpy as np
from PIL import Image
from scipy.interpolate import CubicSpline
from scipy.ndimage import distance_transform_edt, maximum_filter
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
CACHE = ROOT / "scripts" / ".cache" / "day27"
DAY26 = ROOT / "public" / "data" / "day26"
WINDS = ROOT / "scripts" / ".cache" / "day26" / "winds"
OUT = ROOT / "public" / "data" / "day27" / "champi.mp4"

R = 6371.0
EXAG = 4.5
# The storm's detail is blurred this much (cells) for the cloud tops' heights
SMOOTH_FINE = 1.0
SMOOTH_COARSE = 1.0
NOISE_SIZE = 128
# The sun held where it was at one moment (as Day 26's): mid-afternoon at the storm, about 30°
# up in the south-west, low enough for the towers' shadows; and the exposure for it
SUN_AT = dt.datetime(2026, 10, 20, 7, 0, tzinfo=dt.timezone.utc)
EXPOSURE = 0.34
# The grid of the light through the clouds (over the fine scans' box): cells across, down, and
# layers up; tiled this many layers across
LIGHT_GRID = (600, 426, 96)
LIGHT_COLS = 12
# ...and how far it looks towards the sun (km, as drawn): further, and the tops of the storm
# shade one another more, darker at a low sun
LIGHT_REACH = 16.0
# ...worked out again every this many frames
LIGHT_EVERY = 2
# Day 12's fluid on the sea: its box (west, south, width, height, °), the flow's grid and the
# dye's, and its settings (Day 12's: FLUID_DEFAULTS in app/maps/lib/waveFluidSim.ts); a few
# seconds run before the first frame, so the dye's there from the start
FLUID_BOX = (108.0, -2.0, 54.0, 40.0)
FLUID_SIM = (432, 320)
FLUID_DYE = (2160, 1600)
FLUID = {
    "phase": 0.05, "stir": 25.0, "pull": 1.5, "curl": 8.0, "pressure_iterations": 20,
    "velocity_dissipation": 0.15, "relax": 0.35, "plumes": 1.3,
}
FLUID_WARMUP = 12.0
# The waves (and the sea's temperature) worked out again every this many frames
WAVES_EVERY = 3
# Where the track's field is worked out (west, south, width, height, °), and how finely
TRACK_BOX = (115.0, 5.0, 50.0, 32.0)
TRACK_STEP = 0.02
# The land's highest over blocks of this many cells and their neighbours: where there's no land
# near, the march for it is skipped
LAND_BLOCK = 15
# The blocks (cells) over which the highest tops are taken, for striding through clear air
TOP_BLOCK = {"Fine": 10, "Coarse": 5}


# --- data ------------------------------------------------------------------------------


def parse_time(s: str) -> dt.datetime:
    return dt.datetime.strptime(s, "%Y-%m-%dT%H:%MZ").replace(tzinfo=dt.timezone.utc)


class Scans:
    """A run of scans (K, south first) and their blurred copies, with the flow between each pair."""

    def __init__(self, name: str, tb: np.ndarray, times: list[dt.datetime], box: tuple, smooth: float):
        self.name = name
        # (half floats: the wide fine scans are a gigabyte as full ones)
        self.tb = tb.astype(np.float16)
        self.smooth = np.stack([cv2.GaussianBlur(s.astype(np.float32), (0, 0), smooth).astype(np.float16) for s in self.tb])
        self.times = times
        self.box = box  # west, south, width, height (°)
        self.flows: dict[int, np.ndarray] = {}

    def at(self, t: dt.datetime) -> tuple[int, float]:
        """The scan before t, and how far t is from it to the next (a missed scan: across the gap)."""
        i = int(np.clip(np.searchsorted(self.times, t, side="right") - 1, 0, len(self.times) - 2))
        f = (t - self.times[i]) / (self.times[i + 1] - self.times[i])
        return i, float(np.clip(f, 0.0, 1.0))

    def pair(self, i: int) -> np.ndarray:
        return np.stack([self.tb[i], self.smooth[i]], -1).astype(np.float32)

    def flow(self, i: int) -> np.ndarray:
        """The optical flow from scan i to the next (cells), worked out once and kept on disk
        (it's a fifth of a second of CPU for each pair of the fine scans)."""
        if i not in self.flows:
            h, w = self.tb.shape[1:]
            path = CACHE / "flow" / f"{self.name}_{self.times[i]:%Y%m%d_%H%M}_{self.times[i + 1]:%H%M}_{w}x{h}.npy"
            if path.exists():
                flow = np.load(path)
            else:

                def gray(s):
                    return np.clip((300.0 - s.astype(np.float32)) / 120.0 * 255.0, 0, 255).astype(np.uint8)

                flow = cv2.calcOpticalFlowFarneback(gray(self.tb[i]), gray(self.tb[i + 1]), None, 0.5, 5, 21, 5, 7, 1.5, 0)
                path.parent.mkdir(parents=True, exist_ok=True)
                np.save(path, flow.astype(np.float16))
            self.flows = {i: flow.astype(np.float32)}
        return self.flows[i]


def load_fine() -> Scans:
    d = np.load(CACHE / "b13.npz")
    west, south, step = (float(x) for x in d["grid"])
    times = [parse_time(str(s)) for s in d["times"]]
    # (rows to a whole number of TOP_BLOCK's blocks, the northernmost dropped)
    _, h, w = d["tb"].shape
    h -= h % TOP_BLOCK["Fine"]
    w -= w % TOP_BLOCK["Fine"]
    return Scans("fine", d["tb"][:, :h, :w], times, (west, south, w * step, h * step), SMOOTH_FINE)


def load_coarse(first: dt.datetime, last: dt.datetime) -> Scans:
    """Day 26's hourly scans from a little before `first` to a little after `last`."""
    meta = json.loads((DAY26 / "champi.json").read_text())["clouds"]
    start = dt.datetime.fromisoformat(meta["start"].replace("Z", "+00:00"))
    a = int((first - start) / dt.timedelta(hours=1))
    b = int(np.ceil((last - start) / dt.timedelta(hours=1))) + 1
    w, h, cols, per = meta["width"], meta["height"], meta["atlas"]["columns"], meta["atlas"]["frames"]
    atlases: dict[int, np.ndarray] = {}
    scenes = []
    for i in range(a, b + 1):
        f, k = divmod(i, per)
        if f not in atlases:
            atlases[f] = np.asarray(Image.open(DAY26 / f"clouds-{f:02d}.webp").convert("L"))
        y, x = divmod(k, cols)
        q = atlases[f][y * h : (y + 1) * h, x * w : (x + 1) * w][::-1]
        scenes.append(meta["tbMin"] + q.astype(np.float32) * meta["tbStep"])
    box = (meta["west"], meta["south"], w * meta["step"], h * meta["step"])
    times = [start + dt.timedelta(hours=i) for i in range(a, b + 1)]
    return Scans("coarse", np.stack(scenes), times, box, SMOOTH_COARSE)


class Winds:
    """ECMWF's u, v at 850 and 200 hPa every 3 hours (0.5°, node-centred), south first."""

    def __init__(self):
        self.box = (100.0 - 0.25, -5.0 - 0.25, 160 * 0.5, 107 * 0.5)
        self.scenes: dict[dt.datetime, np.ndarray] = {}

    def scene(self, t: dt.datetime) -> np.ndarray:
        if t not in self.scenes:
            self.scenes[t] = np.nan_to_num(np.load(WINDS / f"{t:%Y%m%d%H}.npy"))[::-1].astype(np.float32)
        return self.scenes[t]

    def at(self, t: dt.datetime) -> np.ndarray:
        t0 = t.replace(hour=t.hour // 3 * 3, minute=0, second=0, microsecond=0)
        t1 = t0 + dt.timedelta(hours=3)
        f = (t - t0) / dt.timedelta(hours=3)
        return (1 - f) * self.scene(t0) + f * self.scene(t1)


class Waves:
    """ECMWF's waves every 3 hours (Day 26's: 0.25°, node-centred, a byte each): height (m),
    the way they're going (unit vector east, north), period (s), with land filled from the
    nearest sea (so the coasts don't drag them down); and how much of each cell is sea, and
    how steady the waves' way is round it (Day 12's: 1 all one way, 0 where seas cross)."""

    def __init__(self):
        d = DAY26 / "waves"
        self.meta = json.loads((d / "waves.json").read_text())
        m = self.meta
        self.start = parse_time(m["start"])
        self.dir = d
        self.frames: dict[int, np.ndarray] = {}
        w, h, step = m["width"], m["height"], m["dlon"]
        south = m["lat0"] - (h - 1) * step
        self.box = (m["lng0"] - step / 2, south - step / 2, w * step, h * step)

    def scene(self, i: int) -> np.ndarray:
        if i not in self.frames:
            m = self.meta
            q = np.asarray(Image.open(self.dir / f"{i:03d}.webp").convert("RGB"))[::-1].astype(np.float32)
            land = q[..., 0] == m["land"]
            # (mwd is where they come from)
            mwd = np.radians(q[..., 1] * m["scale"]["mwd"])
            out = np.stack([q[..., 0] * m["scale"]["swh"], -np.sin(mwd), -np.cos(mwd), q[..., 2] * m["scale"]["mwp"]], -1)
            _, (iy, ix) = distance_transform_edt(land, return_indices=True)
            self.frames = {k: v for k, v in self.frames.items() if k >= i - 1}
            self.frames[i] = (out[iy, ix], (~land).astype(np.float32))
        return self.frames[i]

    def at(self, t: dt.datetime) -> np.ndarray:
        x = (t - self.start) / dt.timedelta(hours=self.meta["every"])
        i = int(np.clip(np.floor(x), 0, self.meta["frames"] - 2))
        f = float(np.clip(x - i, 0, 1))
        (a, sa), (b, sb) = self.scene(i), self.scene(i + 1)
        out = (1 - f) * a + f * b
        v = out[..., 1:3]
        out[..., 1:3] = v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-6)
        # (the length of the mean of the unit directions over the cell and its neighbours)
        steady = np.hypot(cv2.blur(out[..., 1], (3, 3)), cv2.blur(out[..., 2], (3, 3)))
        return out, np.stack([np.minimum(sa, sb), steady], -1)


class Sst:
    """NOAA OISST, daily (Day 26's: 0.25° cells, (°C + offset) x scale a byte), each day's taken
    as its noon; land filled from the nearest sea, so the coasts don't bleed."""

    def __init__(self):
        d = DAY26 / "sst"
        m = json.loads((d / "sst.json").read_text())
        self.days = [dt.datetime.fromisoformat(x).replace(hour=12, tzinfo=dt.timezone.utc) for x in m["days"]]
        self.scenes = []
        for i in range(len(m["days"])):
            q = np.asarray(Image.open(d / f"{i:02d}.webp").convert("L"))[::-1].astype(np.float32)
            land = q == m["land"]
            c = q / m["scale"] - m["offset"]
            _, (iy, ix) = distance_transform_edt(land, return_indices=True)
            self.scenes.append(c[iy, ix])
        w, h, step = m["width"], m["height"], m["step"]
        south = m["lat0"] - (h - 1) * step
        self.box = (m["lng0"] - step / 2, south - step / 2, w * step, h * step)

    def at(self, t: dt.datetime) -> np.ndarray:
        x = (t - self.days[0]) / dt.timedelta(days=1)
        i = int(np.clip(np.floor(x), 0, len(self.days) - 2))
        f = float(np.clip(x - i, 0, 1))
        return (1 - f) * self.scenes[i] + f * self.scenes[i + 1]


def load_terrain() -> tuple[np.ndarray, tuple]:
    d = np.load(CACHE / "terrain.npz")
    west, south, step = (float(x) for x in d["grid"])
    h, w = d["elevation"].shape
    return d["elevation"].astype(np.float32), (west, south, w * step, h * step)


def track_texture() -> tuple[np.ndarray, tuple]:
    """Champi's track (as Day 26 draws it, a smooth curve through the fixes), as a field over
    TRACK_BOX: at each place, how far the track is (km), and the hour (since 15 October 00 UTC)
    and the wind (kt) where it's nearest. It never moves, so worked out once (and kept)."""
    w, h = round(TRACK_BOX[2] / TRACK_STEP), round(TRACK_BOX[3] / TRACK_STEP)
    path = CACHE / f"track_{w}x{h}.npy"
    if not path.exists():
        track = json.loads((DAY26 / "champi.json").read_text())["track"]
        hours = np.array([p["hour"] for p in track])
        # (every 3 minutes: a km or so apart)
        every = np.arange(hours[0], hours[-1] + 1e-6, 0.05)
        lat = CubicSpline(hours, [p["lat"] for p in track])(every)
        lon = CubicSpline(hours, [p["lon"] for p in track])(every)
        wind = np.interp(every, hours, [p["wind"] for p in track])
        tree = cKDTree(np.stack([ecef(a, o) for a, o in zip(lat, lon)]))
        glon = TRACK_BOX[0] + TRACK_STEP * (np.arange(w) + 0.5)
        glat = TRACK_BOX[1] + TRACK_STEP * (np.arange(h) + 0.5)
        lo, la = np.meshgrid(np.radians(glon), np.radians(glat))
        pts = R * np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], -1).reshape(-1, 3)
        dist, idx = tree.query(pts)
        field = np.stack([np.minimum(dist, 500.0), every[idx], wind[idx], np.zeros_like(dist)], -1)
        np.save(path, field.reshape(h, w, 4).astype(np.float32))
    return np.load(path), TRACK_BOX


def load_track():
    meta = json.loads((DAY26 / "champi.json").read_text())
    origin = dt.datetime(2026, 10, 15, tzinfo=dt.timezone.utc)
    track = meta["track"]
    hours = np.array([p["hour"] for p in track])
    lat = CubicSpline(hours, [p["lat"] for p in track])
    lon = CubicSpline(hours, [p["lon"] for p in track])

    def at(t: dt.datetime) -> tuple[float, float]:
        x = (t - origin) / dt.timedelta(hours=1)
        return float(lat(x)), float(lon(x))

    return at


def noise_volume(n: int = NOISE_SIZE) -> np.ndarray:
    """Tiling cellular (Worley) noise, inverted (1 in the cells' hearts), three octaves summed."""
    path = CACHE / f"noise{n}.npy"
    if path.exists():
        return np.load(path)
    rng = np.random.default_rng(27)
    g = (np.arange(n) + 0.5) / n
    out = np.zeros((n, n, n), np.float32)
    for cells, weight in ((6, 0.6), (12, 0.28), (24, 0.12)):
        pts = rng.random((cells, cells, cells, 3))
        best = np.full((n, n, n), 9.0, np.float32)
        c = np.floor(g * cells).astype(int)
        fz, fy, fx = np.meshgrid(g * cells, g * cells, g * cells, indexing="ij")
        cz, cy, cx = np.meshgrid(c, c, c, indexing="ij")
        for dz in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    nz, ny, nx = cz + dz, cy + dy, cx + dx
                    p = pts[nz % cells, ny % cells, nx % cells]
                    dist = (nx + p[..., 0] - fx) ** 2 + (ny + p[..., 1] - fy) ** 2 + (nz + p[..., 2] - fz) ** 2
                    np.minimum(best, dist.astype(np.float32), out=best)
        out += weight * (1.0 - np.clip(np.sqrt(best), 0, 1))
    out = (out - out.min()) / (out.max() - out.min())
    CACHE.mkdir(parents=True, exist_ok=True)
    np.save(path, out)
    return out


# --- the sun and the camera ------------------------------------------------------------------


def ecef(lat: float, lon: float, r: float = R) -> np.ndarray:
    la, lo = np.radians(lat), np.radians(lon)
    return r * np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])


def sun_direction(t: dt.datetime) -> np.ndarray:
    """Towards the sun (unit, ECEF): the subsolar point, from NOAA's low-precision formulas."""
    doy = t.timetuple().tm_yday
    hour = t.hour + t.minute / 60 + t.second / 3600
    g = 2 * np.pi / 365 * (doy - 1 + (hour - 12) / 24)
    eqtime = 229.18 * (0.000075 + 0.001868 * np.cos(g) - 0.032077 * np.sin(g) - 0.014615 * np.cos(2 * g) - 0.040849 * np.sin(2 * g))
    decl = 0.006918 - 0.399912 * np.cos(g) + 0.070257 * np.sin(g) - 0.006758 * np.cos(2 * g) + 0.000907 * np.sin(2 * g) - 0.002697 * np.cos(3 * g) + 0.00148 * np.sin(3 * g)
    lon = (12 - hour - eqtime / 60) * 15
    return ecef(np.degrees(decl), lon, 1.0)


def local_frame(lat: float, lon: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    up = ecef(lat, lon, 1.0)
    east = np.cross([0.0, 0.0, 1.0], up)
    east /= np.linalg.norm(east)
    return east, np.cross(up, east), up


def ease(x: float) -> float:
    return x * x * (3 - 2 * x)


class Camera:
    """Going along with the storm: its distance, height angle and bearing from the storm's eye."""

    def __init__(self, track, start: dt.datetime, end: dt.datetime):
        self.track = track
        self.start, self.end = start, end

    def at(self, t: dt.datetime) -> tuple[np.ndarray, np.ndarray]:
        x = (t - self.start) / (self.end - self.start)
        lat, lon = self.track(t)
        east, north, up = local_frame(lat, lon)
        # From the south-east to the south, high and far enough back for the whole storm, the sea
        # round it, the Philippines on the left, the track behind it and ahead (as Day 26 looks)
        bearing = np.radians(140 + 40 * ease(x))
        elev = np.radians(52 - 4 * np.sin(np.pi * x))
        dist = 3400 - 300 * np.sin(np.pi * x)
        eye = ecef(lat, lon) + dist * (np.cos(elev) * (np.sin(bearing) * east + np.cos(bearing) * north) + np.sin(elev) * up)
        target = ecef(lat, lon) + up * 35.0 - (np.sin(bearing) * east + np.cos(bearing) * north) * 120.0
        fwd = target - eye
        fwd /= np.linalg.norm(fwd)
        right = np.cross(fwd, up)
        right /= np.linalg.norm(right)
        cam_up = np.cross(right, fwd)
        # Columns: the camera's x, y and z (looking down -z) in ECEF
        return eye, np.stack([right, cam_up, -fwd], axis=1)


# --- rendering ----------------------------------------------------------------------------------


class Fluid:
    """Day 12's fluid (shaders/fluid.glsl) over FLUID_BOX, stepped once a frame, carrying on
    from the last: the flow on a grid of FLUID_SIM, the dye on one of FLUID_DYE."""

    PASSES = ["MEAN", "FORCE", "CURL", "VORTICITY", "DIVERGENCE", "PRESSURE", "GRADIENT", "ADVECT", "INJECT", "DEEP"]

    def __init__(self, ctx: moderngl.Context, vert: str, quad: moderngl.Buffer):
        self.ctx = ctx
        src = (HERE / "shaders" / "fluid.glsl").read_text()
        self.progs = {
            p: ctx.program(vertex_shader=vert, fragment_shader=f"#version 410\n#define PASS_{p}\n" + src) for p in self.PASSES
        }
        self.vaos = {p: ctx.vertex_array(prog, [(quad, "2f", "aPos")]) for p, prog in self.progs.items()}

        def target(size, dtype="f4"):
            tex = ctx.texture(size, 4, dtype=dtype)
            tex.repeat_x = tex.repeat_y = False
            return tex, ctx.framebuffer([tex])

        self.sim, self.dye_size = FLUID_SIM, FLUID_DYE
        self.velocity = [target(FLUID_SIM), target(FLUID_SIM)]
        self.pressure = [target(FLUID_SIM), target(FLUID_SIM)]
        # (the dye in half floats: it's 3.5 M texels, read and written twice a step)
        self.dye = [target(FLUID_DYE, "f2"), target(FLUID_DYE, "f2")]
        self.deep = target(FLUID_DYE, "f2")
        self.mean, self.divergence, self.curl = target(FLUID_SIM), target(FLUID_SIM), target(FLUID_SIM)
        for t, f in self.velocity + self.pressure + self.dye:
            f.clear(0, 0, 0, 0)
        self.time = 0.0
        self.run("DEEP", self.deep, FLUID_DYE, {})

    def run(self, name: str, out, size, textures: dict, **uniforms) -> None:
        prog = self.progs[name]
        for unit, (k, tex) in enumerate(textures.items()):
            if k in prog:
                tex.use(unit)
                prog[k] = unit
        uniforms = {"uBox": FLUID_BOX, "uTexel": (1 / size[0], 1 / size[1]), **uniforms}
        for k, v in uniforms.items():
            if k in prog:
                prog[k].value = v
        out[1].use()
        self.vaos[name].render(moderngl.TRIANGLE_STRIP)

    def step(self, dt: float, waves: moderngl.Texture, sea: moderngl.Texture, waves_box: tuple) -> None:
        S, D = self.sim, self.dye_size
        w = {"uWaves": waves, "uWavesSea": sea}
        common = {"uDt": dt, "uTime": self.time, "uWavesBox": waves_box}
        v, pr, dy = self.velocity, self.pressure, self.dye
        self.run("MEAN", self.mean, S, w, uPhaseSpeed=FLUID["phase"], **common)
        self.run("FORCE", v[1], S, {**w, "uVelocity": v[0][0]}, uStir=FLUID["stir"], uPull=FLUID["pull"], **common)
        v.reverse()
        self.run("CURL", self.curl, S, {"uVelocity": v[0][0]}, **common)
        self.run("VORTICITY", v[1], S, {"uVelocity": v[0][0], "uCurl": self.curl[0]}, uConfinement=FLUID["curl"], **common)
        v.reverse()
        self.run("DIVERGENCE", self.divergence, S, {"uVelocity": v[0][0]}, **common)
        for i in range(FLUID["pressure_iterations"]):
            self.run("PRESSURE", pr[1], S, {"uPressure": pr[0][0], "uDivergence": self.divergence[0]}, uKeep=0.8 if i == 0 else 1.0, **common)
            pr.reverse()
        self.run("GRADIENT", v[1], S, {"uPressure": pr[0][0], "uVelocity": v[0][0]}, **common)
        v.reverse()
        sim_texel = (1 / S[0], 1 / S[1])
        self.run("ADVECT", v[1], S, {"uMean": self.mean[0], "uVelocity": v[0][0], "uSource": v[0][0]},
                 uSimTexel=sim_texel, uDissipation=FLUID["velocity_dissipation"], **common)
        v.reverse()
        self.run("ADVECT", dy[1], D, {"uMean": self.mean[0], "uVelocity": v[0][0], "uSource": dy[0][0]},
                 uSimTexel=sim_texel, uDissipation=0.0, **common)
        dy.reverse()
        self.run("INJECT", dy[1], D, {**w, "uDye": dy[0][0], "uDeep": self.deep[0]}, uRelax=FLUID["relax"], uPlumes=FLUID["plumes"], **common)
        dy.reverse()
        self.time += dt

    @property
    def texture(self) -> moderngl.Texture:
        return self.dye[0][0]


class Renderer:
    """Three passes a frame (see shaders/common.glsl): the clouds at each place, the light
    through them, the picture; then tone mapped and read back."""

    UNITS = [
        "uFineA", "uFineB", "uFineFlow", "uCoarseA", "uCoarseB", "uCoarseFlow", "uWinds", "uNoise",
        "uColFine", "uColFineTb", "uColCoarse", "uColCoarseTb", "uLight",
        "uTerrain", "uWaves", "uSst", "uTrack", "uTopMaxFine", "uTopMaxCoarse", "uCloud", "uCloudDepth",
        "uWavesSea", "uDye", "uLandMax",
    ]

    def __init__(
        self, width: int, height: int, fine_size: tuple, coarse_size: tuple, cloud_scale: float, blend: float, fov: float = 38.0
    ):
        self.ctx = moderngl.create_standalone_context(require=410)
        self.w, self.h = width, height
        shaders = HERE / "shaders"
        vert = (shaders / "fullscreen.vert").read_text()
        common = (shaders / "common.glsl").read_text()

        def program(name: str, shared: bool = True) -> moderngl.Program:
            src = (shaders / name).read_text()
            if shared:
                src = "#version 410\n" + common + "\n" + src
            return self.ctx.program(vertex_shader=vert, fragment_shader=src)

        self.columns = program("columns.frag")
        self.topmax = program("topmax.frag")
        self.light = program("light.frag")
        self.scene = program("scene.frag")
        self.tone = program("tonemap.frag", shared=False)
        self.resolve = program("resolve.frag", shared=False)
        self.programs = [self.columns, self.topmax, self.light, self.scene]
        quad = self.ctx.buffer(np.array([-1, -1, 1, -1, -1, 1, 1, 1], np.float32).tobytes())
        self.fluid = Fluid(self.ctx, vert, quad)
        self.vaos = {id(p): self.ctx.vertex_array(p, [(quad, "2f", "aPos")]) for p in self.programs + [self.tone, self.resolve]}
        self.units = {name: unit for unit, name in enumerate(self.UNITS)}
        for p in self.programs:
            for name, unit in self.units.items():
                if name in p:
                    p[name] = unit
        self.textures: dict[str, moderngl.Texture] = {}

        def target(size, comps, name):
            tex = self.ctx.texture(size, comps, dtype="f4")
            tex.repeat_x = tex.repeat_y = False
            self.textures[name] = tex
            return tex

        # Pass 1's grids: the same as the scans'
        self.col_fbos = {}
        for key, size in (("Fine", fine_size), ("Coarse", coarse_size)):
            self.col_fbos[key] = (self.ctx.framebuffer([target(size, 4, f"uCol{key}"), target(size, 1, f"uCol{key}Tb")]), size)
        # Pass 1b's: blocks of each (the same box, so they share its texture coordinates)
        self.top_fbos = {}
        for key, size in (("Fine", fine_size), ("Coarse", coarse_size)):
            block = TOP_BLOCK[key]
            assert size[0] % block == 0 and size[1] % block == 0, (key, size, block)
            tex = target((size[0] // block, size[1] // block), 1, f"uTopMax{key}")
            self.top_fbos[key] = (self.ctx.framebuffer([tex]), block)
        # Pass 2's grid: LIGHT_GRID over the fine box, its layers tiled LIGHT_COLS across
        gw, gh, layers = LIGHT_GRID
        rows = -(-layers // LIGHT_COLS)
        self.light_fbo = self.ctx.framebuffer([target((gw * LIGHT_COLS, gh * rows), 1, "uLight")])
        self.light_grid = (gw, gh, layers, LIGHT_COLS)

        # Pass 3's clouds, at a lower resolution: this frame's, and (3b) those carried on from the
        # frames before, two to swap between
        self.cloud_size = (round(width * cloud_scale), round(height * cloud_scale))

        def cloud_target():
            c = self.ctx.texture(self.cloud_size, 4, dtype="f4")
            d = self.ctx.texture(self.cloud_size, 1, dtype="f4")
            for t in (c, d):
                t.repeat_x = t.repeat_y = False
            return c, d, self.ctx.framebuffer([c, d])

        self.raw_color, self.raw_depth, self.raw_fbo = cloud_target()
        self.history = [cloud_target(), cloud_target()]
        self.textures["uCloud"], self.textures["uCloudDepth"] = self.history[0][0], self.history[0][1]
        self.blend = blend
        self.clouds = True
        self.frame_no = 0
        self.cam = self.cam_rot = self.prev_cam = self.prev_rot = None
        self.hdr = self.ctx.texture((width, height), 4, dtype="f4")
        self.hdr_fbo = self.ctx.framebuffer([self.hdr])
        self.ldr = self.ctx.texture((width, height), 4)
        self.ldr_fbo = self.ctx.framebuffer([self.ldr])
        self.pbos = [self.ctx.buffer(reserve=width * height * 3) for _ in range(2)]
        self.pending = None
        self.reads = 0
        tan_y = np.tan(np.radians(fov / 2))
        self.tan_fov = (tan_y * width / height, tan_y)
        noise = noise_volume()
        tex = self.ctx.texture3d(noise.shape, 1, noise.astype(np.float32).tobytes(), dtype="f4")
        tex.repeat_x = tex.repeat_y = tex.repeat_z = True
        self.textures["uNoise"] = tex

    def upload(self, name: str, data: np.ndarray) -> None:
        """A 2D float texture (rows south first), replaced in place when it's the same size."""
        h, w = data.shape[:2]
        comps = 1 if data.ndim == 2 else data.shape[2]
        tex = self.textures.get(name)
        if tex is None or tex.size != (w, h) or tex.components != comps:
            if tex is not None:
                tex.release()
            tex = self.ctx.texture((w, h), comps, dtype="f4")
            tex.repeat_x = tex.repeat_y = False
            self.textures[name] = tex
        tex.write(np.ascontiguousarray(data, np.float32).tobytes())

    def set(self, **uniforms) -> None:
        for k, v in uniforms.items():
            for p in self.programs:
                if k in p:
                    p[k].value = tuple(np.asarray(v, np.float64).ravel().tolist()) if np.ndim(v) else v

    def bind(self, *skip: str) -> None:
        for name, tex in self.textures.items():
            if name in self.units and name not in skip:
                tex.use(self.units[name])

    def draw(self, prog: moderngl.Program, fbo: moderngl.Framebuffer) -> None:
        """A full-screen pass. (Not waited on: each pass is tens of ms now, far from the GPU's
        watchdog, and waiting after each held the CPU and the GPU back from working together;
        the frame's read back is the only wait.)"""
        fbo.use()
        self.vaos[id(prog)].render(moderngl.TRIANGLE_STRIP)

    def bake(self) -> None:
        """Passes 1, 1b and 2: what's the same at every step of every pixel (with clouds)."""
        # 1. The clouds at each place: each grid with its own box
        self.bind("uColFine", "uColFineTb", "uColCoarse", "uColCoarseTb", "uLight")
        for key, (fbo, size) in self.col_fbos.items():
            self.columns["uBakeBox"].value = self.box[key]
            self.columns["uBakeSize"].value = size
            self.draw(self.columns, fbo)
        # 1b. The highest tops near each block
        self.bind("uTopMaxFine", "uTopMaxCoarse", "uLight")
        for key, (fbo, block) in self.top_fbos.items():
            self.textures[f"uCol{key}"].use(20)
            self.topmax["uTopSrc"] = 20
            self.topmax["uBlock"] = block
            self.draw(self.topmax, fbo)
        # 2. The light through them: every other frame (the sun and the clouds hardly move from
        # one to the next)
        if self.frame_no % LIGHT_EVERY == 0:
            self.bind("uLight")
            self.draw(self.light, self.light_fbo)

    def frame(self, exposure: float) -> np.ndarray:
        self.set(uLightGrid=self.light_grid)
        if self.clouds:
            self.bake()
        # 3. The clouds, at a lower resolution, the march started at a different point each frame
        # (not shifted across the screen: that set the far clouds, seen edge on, trembling up and
        # down); then 3b, blended into the last frame's, taken to where they are now
        k = self.frame_no
        self.set(uJitter=(0.0, 0.0), uSeed=float(k % 64) * 1.37)
        self.bind("uCloud", "uCloudDepth")
        self.set(uMode=0, uViewport=self.cloud_size)
        self.draw(self.scene, self.raw_fbo)
        history, out = self.history
        self.raw_color.use(21)
        self.raw_depth.use(22)
        history[0].use(23)
        rv = self.resolve
        rv["uRaw"], rv["uRawDepth"], rv["uHistory"] = 21, 22, 23
        rv["uCam"].value = tuple(self.cam)
        rv["uCamRot"].value = tuple(self.cam_rot.T.ravel())
        rv["uPrevCam"].value = tuple(self.prev_cam if self.prev_cam is not None else self.cam)
        rv["uPrevCamRot"].value = tuple((self.prev_rot if self.prev_rot is not None else self.cam_rot).T.ravel())
        rv["uTanFov"].value = self.tan_fov
        rv["uBlend"].value = 1.0 if self.prev_cam is None else self.blend
        self.draw(rv, out[2])
        self.history.reverse()
        self.textures["uCloud"], self.textures["uCloudDepth"] = out[0], out[1]
        self.prev_cam, self.prev_rot = self.cam, self.cam_rot
        self.frame_no += 1
        # 3c. The ground and the air, at full resolution, with the clouds laid in
        self.bind()
        self.set(uMode=1, uViewport=(self.w, self.h), uJitter=(0.0, 0.0))
        self.draw(self.scene, self.hdr_fbo)
        self.ldr_fbo.use()
        self.hdr.use(15)
        self.tone["uHdr"] = 15
        self.tone["uExposure"] = exposure
        self.vaos[id(self.tone)].render(moderngl.TRIANGLE_STRIP)
        # Read back without waiting: into one of two pixel buffers, while the last frame's (done
        # by now) is handed back. Rows bottom first (ffmpeg flips them)
        pbo = self.pbos[self.reads % 2]
        self.reads += 1
        self.ldr_fbo.read_into(pbo, components=3)
        last, self.pending = self.pending, pbo
        return last.read() if last is not None else None

    def flush(self) -> bytes | None:
        """The last frame's pixels, still to be handed back."""
        last, self.pending = self.pending, None
        return last.read() if last is not None else None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--seconds", type=float, default=24.0)
    parser.add_argument("--steps", type=int, default=100, help="steps through the cloud layer (each frame; the frames before add theirs)")
    parser.add_argument("--blend", type=float, default=0.25, help="how much of each frame's clouds go in over the last's (1: none carried on)")
    parser.add_argument("--no-clouds", action="store_true", help="the sea, the land and the track alone")
    parser.add_argument("--cloud-scale", type=float, default=0.5, help="the clouds' resolution, as a part of the frame's")
    parser.add_argument("--still", help="render one frame at this UTC time (HH:MM; before 12:00 is the 20th)")
    parser.add_argument("--frames", help="only frames a:b (for drafts)")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()

    fine = load_fine()
    first, last = fine.times[0], fine.times[-1]
    coarse = load_coarse(first, last)
    winds = Winds()
    track = load_track()
    camera = Camera(track, first, last)
    size = lambda s: (s.tb.shape[2], s.tb.shape[1])  # noqa: E731
    r = Renderer(args.width, args.height, size(fine), size(coarse), args.cloud_scale, args.blend)
    r.box = {"Fine": fine.box, "Coarse": coarse.box}
    r.set(uExag=EXAG, uSteps=args.steps, uSigma=0.3, uLightReach=LIGHT_REACH, uViewport=(args.width, args.height), uTanFov=r.tan_fov)
    r.set(uFineBox=fine.box, uCoarseBox=coarse.box, uWindBox=winds.box)
    waves, sst = Waves(), Sst()
    terrain, terrain_box = load_terrain()
    r.upload("uTerrain", terrain)
    track_tex, track_box = track_texture()
    r.upload("uTrack", track_tex)
    # (the land's highest near each block, km as drawn; the terrain's size a whole number of blocks)
    th, tw = terrain.shape
    blocks = terrain[: th // LAND_BLOCK * LAND_BLOCK, : tw // LAND_BLOCK * LAND_BLOCK]
    blocks = blocks.reshape(th // LAND_BLOCK, LAND_BLOCK, tw // LAND_BLOCK, LAND_BLOCK).max(axis=(1, 3))
    r.upload("uLandMax", maximum_filter(blocks, size=3) * 1e-3 * EXAG)
    lb = (terrain_box[0], terrain_box[1], terrain_box[2] * (tw // LAND_BLOCK * LAND_BLOCK) / tw, terrain_box[3] * (th // LAND_BLOCK * LAND_BLOCK) / th)
    r.set(uTerrainBox=terrain_box, uLandMaxBox=lb, uWavesBox=waves.box, uSstBox=sst.box, uTrackBox=track_box)
    r.set(uClouds=0.0 if args.no_clouds else 1.0)
    r.clouds = not args.no_clouds
    r.set(uDyeBox=FLUID_BOX, uDyeTexel=(1 / FLUID_DYE[0], 1 / FLUID_DYE[1]))
    origin = dt.datetime(2026, 10, 15, tzinfo=dt.timezone.utc)

    warm = [True]
    count = [0]
    sent: dict[str, int] = {}

    def draw(t: dt.datetime, clock: float) -> bytes | None:
        # The scans either side, and the flow between: sent again only when they change (every
        # nine frames or so; they're tens of MB)
        i, f = fine.at(t)
        if args.no_clouds:
            pass
        elif sent.get("fine") != i:
            r.upload("uFineA", fine.pair(i))
            r.upload("uFineB", fine.pair(i + 1))
            r.upload("uFineFlow", fine.flow(i))
            sent["fine"] = i
        j, g = coarse.at(t)
        if args.no_clouds:
            pass
        elif sent.get("coarse") != j:
            r.upload("uCoarseA", coarse.pair(j))
            r.upload("uCoarseB", coarse.pair(j + 1))
            r.upload("uCoarseFlow", coarse.flow(j))
            sent["coarse"] = j
        if not args.no_clouds:
            r.upload("uWinds", winds.at(t))
        # (the waves every few frames: they're 3-hourly, and hardly change from one to the next)
        if count[0] % WAVES_EVERY == 0:
            sea_now, sea_mask = waves.at(t)
            r.upload("uWaves", sea_now)
            r.upload("uWavesSea", sea_mask)
        count[0] += 1
        # The fluid: a step a frame (a few seconds' worth first, to fill it with dye)
        steps = round(FLUID_WARMUP * args.fps) if warm[0] else 1
        warm[0] = False
        for _ in range(steps):
            r.fluid.step(1 / args.fps, r.textures["uWaves"], r.textures["uWavesSea"], waves.box)
        r.textures["uDye"] = r.fluid.texture
        r.upload("uSst", sst.at(t))
        eye, rot = camera.at(t)
        sun = sun_direction(SUN_AT)
        lat, lon = track(t)
        # (GLSL reads a mat3 column by column)
        r.set(uFineF=f, uCoarseF=g, uCam=eye, uCamRot=rot.T, uSun=sun, uDrift=(t - first).total_seconds())
        r.cam, r.cam_rot = eye, rot
        r.set(uHour=(t - origin) / dt.timedelta(hours=1), uClock=clock)
        r.set(uGlow=0.4 / EXPOSURE)
        return r.frame(EXPOSURE)

    if args.still:
        hh, mm = (int(x) for x in args.still.split(":"))
        day = 19 if hh >= 12 else 20
        t = dt.datetime(2026, 10, day, hh, mm, tzinfo=dt.timezone.utc)
        t0 = time.time()
        draw(t, (t - first) / (last - first) * args.seconds)
        img = np.frombuffer(r.flush(), np.uint8).reshape(args.height, args.width, 3)[::-1]
        out = args.out or Path(f"/tmp/day27_{hh:02d}{mm:02d}.png")
        Image.fromarray(img).save(out)
        print(f"{out} ({time.time() - t0:.1f} s)")
        return

    n = round(args.fps * args.seconds)
    a, b = (int(x) for x in args.frames.split(":")) if args.frames else (0, n)
    out = args.out or (OUT.with_name(OUT.stem + "-noclouds.mp4") if args.no_clouds else OUT)
    out.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = subprocess.Popen(
        [
            imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{args.width}x{args.height}", "-r", str(args.fps), "-i", "-",
            "-vf", "vflip", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            str(out),
        ],
        stdin=subprocess.PIPE,
    )
    # Frames handed to ffmpeg from another thread, so the next is drawn meanwhile
    frames: queue.Queue = queue.Queue(maxsize=4)

    def write():
        while (px := frames.get()) is not None:
            ffmpeg.stdin.write(px)

    writer = threading.Thread(target=write)
    writer.start()
    t0 = time.time()
    for k in range(a, b):
        t = first + (last - first) * (k / (n - 1))
        px = draw(t, k / args.fps)
        if px is not None:
            frames.put(px)
        done = k - a + 1
        eta = (time.time() - t0) / done * (b - a - done)
        print(f"\r  frame {k + 1}/{n} {t:%H:%M} UTC, {eta / 60:.0f} min to go ", end="", file=sys.stderr, flush=True)
    frames.put(r.flush())
    frames.put(None)
    writer.join()
    ffmpeg.stdin.close()
    ffmpeg.wait()
    print(f"\n{out}: {out.stat().st_size / 1e6:.1f} MB in {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
