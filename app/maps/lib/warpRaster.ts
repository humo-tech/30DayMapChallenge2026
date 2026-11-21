// A plate carrée raster (equal latitude / longitude, e.g. NASA's Blue Marble) warped onto a
// freehand map. A latitude / longitude grid goes through the projection (forward only, so it's
// quick); each cell becomes two triangles textured with the raster, drawn by WebGL into a picture
// the size of the art. Cells whose corners fall in different frames (across the edge of an inset,
// or off the map) are left out, so each frame is warped on its own; so are cells across the
// world map's cut.
import type { FreehandProjection, XY } from './freehand'

export type WarpOptions = {
  bbox: [number, number, number, number] // the raster's west, south, east, north
  width: number // the art's size, in art units
  height: number
  scale: number // pixels per art unit in the result
  lng: [number, number] // the grid's range (may run past 180°: the raster repeats east-west)
  lat: [number, number]
  step: number // grid spacing, degrees
}

const VERT = `#version 300 es
in vec2 aPos;
in vec2 aUv;
uniform vec2 uSize;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPos.x / uSize.x * 2.0 - 1.0, 1.0 - aPos.y / uSize.y * 2.0, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 outColor;
void main() {
  outColor = texture(uTex, vUv);
}`

/** The triangles: positions on the art and texture coordinates, three vertices each */
export function warpMesh(proj: FreehandProjection, o: WarpOptions): { pos: Float32Array; uv: Float32Array } {
  const [w, s, e, n] = o.bbox
  const nx = Math.round((o.lng[1] - o.lng[0]) / o.step) + 1
  const ny = Math.round((o.lat[1] - o.lat[0]) / o.step) + 1
  const xy: (XY | null)[] = new Array(nx * ny)
  const frame = new Int16Array(nx * ny)
  for (let j = 0; j < ny; j++) {
    const lat = o.lat[1] - j * o.step
    for (let i = 0; i < nx; i++) {
      const lng = o.lng[0] + i * o.step
      const fi = proj.frameOf(lng, lat)
      const ok = fi >= 0 && proj.fitted(fi)
      frame[j * nx + i] = ok ? fi : -1
      xy[j * nx + i] = ok ? proj.project(lng, lat, fi) : null
    }
  }
  const pos: number[] = []
  const uv: number[] = []
  // A triangle across the world map's cut has corners at both edges: leave it out
  const maxEdge = o.width / 4
  const near = (p: number, q: number) => {
    const a = xy[p]!
    const b = xy[q]!
    return Math.abs(a[0] - b[0]) < maxEdge && Math.abs(a[1] - b[1]) < maxEdge
  }
  const tri = (p: number, q: number, r: number) => near(p, q) && near(q, r) && near(r, p)
  const put = (i: number, j: number) => {
    const p = xy[j * nx + i]!
    pos.push(p[0], p[1])
    uv.push((o.lng[0] + i * o.step - w) / (e - w), (n - (o.lat[1] - j * o.step)) / (n - s))
  }
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = frame[j * nx + i]!
      const b = frame[j * nx + i + 1]!
      const c = frame[(j + 1) * nx + i]!
      const d = frame[(j + 1) * nx + i + 1]!
      const [ia, ib, ic, id] = [j * nx + i, j * nx + i + 1, (j + 1) * nx + i, (j + 1) * nx + i + 1]
      if (a >= 0 && a === b && a === c && tri(ia, ib, ic)) {
        put(i, j)
        put(i + 1, j)
        put(i, j + 1)
      }
      if (d >= 0 && d === b && d === c && tri(ib, id, ic)) {
        put(i + 1, j)
        put(i + 1, j + 1)
        put(i, j + 1)
      }
    }
  }
  return { pos: Float32Array.from(pos), uv: Float32Array.from(uv) }
}

function shader(gl: WebGL2RenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader')
  return sh
}

/** Draws the warped raster; resolves to an object URL of a PNG the size of the art (times scale) */
export async function warpRaster(proj: FreehandProjection, image: HTMLImageElement, o: WarpOptions): Promise<string> {
  const { pos, uv } = warpMesh(proj, o)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(o.width * o.scale)
  canvas.height = Math.round(o.height * o.scale)
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true })
  if (!gl) throw new Error('WebGL2 is not available')

  const prog = gl.createProgram()!
  gl.attachShader(prog, shader(gl, gl.VERTEX_SHADER, VERT))
  gl.attachShader(prog, shader(gl, gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(prog)
  gl.useProgram(prog)

  const attr = (name: string, data: Float32Array) => {
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, name)
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  }
  attr('aPos', pos)
  attr('aUv', uv)

  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
  gl.generateMipmap(gl.TEXTURE_2D)
  // East-west it goes round (the world map's grid runs past 180°); north-south it stops
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic')
  if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8)

  gl.uniform2f(gl.getUniformLocation(prog, 'uSize'), o.width, o.height)
  gl.viewport(0, 0, canvas.width, canvas.height)
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.drawArrays(gl.TRIANGLES, 0, pos.length / 2)

  const blob = await new Promise<Blob>((ok, ko) => canvas.toBlob((b) => (b ? ok(b) : ko(new Error('toBlob failed'))), 'image/png'))
  gl.getExtension('WEBGL_lose_context')?.loseContext()
  return URL.createObjectURL(blob)
}
