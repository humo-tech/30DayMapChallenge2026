// Melting clocks for Navara: big pastel clocks floating over the city, each one sagging like
// Dalí's watches and undulating in the air, their hands running backwards, far too fast.
//
// A clock is a plane drawn as a clock in the fragment shader, in the plane's own uv; the vertex
// shader then stretches the lower part down and waves it, so the clock goes with it. Each turns
// about the vertical to face the camera. Placed in metres east (x) and north (y) of the mesh's
// origin, and up: place the mesh with `geodetic` there. (Its frame is West-Up-North.)
import { MeshDesc, setupMaterialForMRT, type MeshConfig, type MeshUpdate } from '@navaramap/three'
import { Color, DoubleSide, Group, Mesh, PlaneGeometry, ShaderMaterial, Vector3 } from 'three'

export type Clock = {
  /** East and north of the origin, and up (m) */
  at: [number, number, number]
  /** Face width (m) */
  size: number
  /** How far it has melted (0-1), and the pace of the hands (turns a minute: negative runs backwards) */
  melt: number
  pace: number
  /** Rim and face colors */
  rim: string
  face: string
}
type Description = { meltingClocks?: { clocks: Clock[] } }
export type MeltingClocksConfig = MeshConfig & Description
type MeltingClocksUpdate = MeshUpdate & Description

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uMelt;
  uniform float uSeed;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec3 p = position; // -0.5 .. 0.5
    float low = clamp(0.5 - p.y, 0.0, 1.0);   // 0 at the top, 1 at the bottom
    // The bottom runs down, more in the middle than at the sides, and swells and shrinks
    float sag = uMelt * (0.35 + 0.65 * (1.0 - pow(abs(p.x) * 2.0, 2.0))) * pow(low, 1.6);
    p.y -= sag * (0.9 + 0.12 * sin(uTime * 0.9 + uSeed));
    p.x *= 1.0 + 0.35 * uMelt * low * sin(uTime * 0.7 + uSeed * 2.0);
    // Waves, running down it
    p.x += 0.025 * sin(p.y * 9.0 - uTime * 1.6 + uSeed);
    p.z += 0.07 * sin(p.x * 6.0 + uTime * 1.1 + uSeed) * (0.3 + low) + 0.04 * sin(p.y * 7.0 - uTime * 1.9);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uPace;
  uniform vec3 uRim;
  uniform vec3 uFace;
  uniform float uSeed;
  varying vec2 vUv;

  const float TAU = 6.2831853;

  float segment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
  }
  vec2 hand(float turns) {
    float a = turns * TAU;
    return vec2(sin(a), cos(a));
  }

  void main() {
    // The clock face on the plane's uv: a circle, a touch taller than wide (it melts down)
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    float aa = fwidth(r) * 1.5;
    float disc = 1.0 - smoothstep(0.96 - aa, 0.96 + aa, r);
    if (disc < 0.01) discard;

    vec3 col = uFace;
    // Rim: a thick band with a stitched line inside
    float rim = smoothstep(0.80 - aa, 0.80 + aa, r);
    col = mix(col, uRim, rim);
    float stitch = step(0.5, fract(atan(p.y, p.x) / TAU * 90.0)) * (1.0 - smoothstep(0.006, 0.014, abs(r - 0.88)));
    col = mix(col, vec3(1.0), stitch * 0.9);

    // Twelve hours
    float ang = atan(p.x, p.y);
    float cell = fract(ang / TAU * 12.0 + 0.5) - 0.5;
    float hourMark = 1.0 - smoothstep(0.02, 0.05, abs(cell) * r * 3.0);
    float inMark = smoothstep(0.58, 0.60, r) * (1.0 - smoothstep(0.70, 0.72, r));
    col = mix(col, uRim * 0.55, hourMark * inMark);

    // The hands: hour, minute and second, running backwards at uPace turns a minute
    float t = uTime / 60.0 * uPace;
    float d = 1e3;
    d = min(d, segment(p, vec2(0.0), hand(t / 12.0) * 0.40) - 0.035);
    d = min(d, segment(p, vec2(0.0), hand(t) * 0.62) - 0.025);
    col = mix(col, uRim * 0.45, 1.0 - smoothstep(0.0, 0.012, d));
    float sec = segment(p, hand(t * 60.0) * -0.12, hand(t * 60.0) * 0.68) - 0.008;
    col = mix(col, vec3(1.0, 0.42, 0.55), 1.0 - smoothstep(0.0, 0.01, sec));
    col = mix(col, uRim * 0.45, 1.0 - smoothstep(0.045, 0.05, r));

    gl_FragColor = vec4(col, disc * 0.96);
  }
`

export class MeltingClocksMeshDesc extends MeshDesc<MeltingClocksConfig, MeltingClocksUpdate, Group> {
  private clocks: { holder: Group; material: ShaderMaterial; geometry: PlaneGeometry; at: Vector3 }[] = []
  private camera = new Vector3()
  private config: MeltingClocksConfig

  constructor(...args: ConstructorParameters<typeof MeshDesc<MeltingClocksConfig, MeltingClocksUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  override createMesh() {
    const root = new Group()
    root.frustumCulled = false
    this.config.meltingClocks?.clocks.forEach((c, i) => {
      const geometry = new PlaneGeometry(1, 1, 36, 36)
      const material = new ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
          uTime: { value: 0 },
          uMelt: { value: c.melt },
          uPace: { value: c.pace },
          uSeed: { value: i * 2.17 },
          uRim: { value: new Color(c.rim) },
          uFace: { value: new Color(c.face) },
        },
        side: DoubleSide,
        transparent: true,
      })
      setupMaterialForMRT(material)
      const mesh = new Mesh(geometry, material)
      mesh.frustumCulled = false
      mesh.scale.setScalar(c.size)
      const holder = new Group()
      // ENU -> West-Up-North
      holder.position.set(-c.at[0], c.at[2], c.at[1])
      holder.add(mesh)
      root.add(holder)
      this.clocks.push({ holder, material, geometry, at: holder.position.clone() })
    })
    return root
  }

  /** Runs the clocks to `time` (s), each turned to face the camera and bobbing on its own beat. */
  tick(time: number): void {
    const mesh = this.raw
    if (!mesh) return
    mesh.updateWorldMatrix(true, false)
    this.camera.setFromMatrixPosition(this.view.camera.raw.matrixWorld)
    const eye = mesh.worldToLocal(this.camera)
    this.clocks.forEach((c, i) => {
      c.material.uniforms.uTime!.value = time
      c.holder.position.y = c.at.y + 6 * Math.sin(time * 0.5 + i * 1.9)
      c.holder.rotation.y = Math.atan2(eye.x - c.at.x, eye.z - c.at.z)
    })
  }

  override onDestroy(): void {
    super.onDestroy()
    for (const c of this.clocks) {
      c.geometry.dispose()
      c.material.dispose()
    }
    this.clocks = []
  }
}
