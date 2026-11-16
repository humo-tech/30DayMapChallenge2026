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
  uniform float uYaw;
  uniform float uSize;
  uniform vec3 uCenter;
  uniform vec3 uEye;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vT;
  varying vec3 vB;
  varying vec3 vL;
  varying vec3 vV;

  // The plane's point melted: -0.5 .. 0.5 in, sagging and waving out
  vec3 melt(vec3 p) {
    float low = clamp(0.5 - p.y, 0.0, 1.0);   // 0 at the top, 1 at the bottom
    // The bottom runs down, more in the middle than at the sides, and swells and shrinks
    float sag = uMelt * (0.35 + 0.65 * (1.0 - pow(abs(p.x) * 2.0, 2.0))) * pow(low, 1.6);
    p.y -= sag * (0.9 + 0.12 * sin(uTime * 0.9 + uSeed));
    p.x *= 1.0 + 0.35 * uMelt * low * sin(uTime * 0.7 + uSeed * 2.0);
    // Waves, running down it
    p.x += 0.025 * sin(p.y * 9.0 - uTime * 1.6 + uSeed);
    p.z += 0.07 * sin(p.x * 6.0 + uTime * 1.1 + uSeed) * (0.3 + low) + 0.04 * sin(p.y * 7.0 - uTime * 1.9);
    return p;
  }
  // About the vertical, as the clock turns to face the camera
  vec3 turn(vec3 v) {
    float c = cos(uYaw), s = sin(uYaw);
    return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z);
  }

  void main() {
    vUv = uv;
    vec3 p = melt(position);
    // The surface's own frame, from the neighbours of this point
    const float e = 0.012;
    vec3 du = melt(position + vec3(e, 0.0, 0.0)) - melt(position - vec3(e, 0.0, 0.0));
    vec3 dv = melt(position + vec3(0.0, e, 0.0)) - melt(position - vec3(0.0, e, 0.0));
    vT = normalize(turn(du));
    vB = normalize(turn(dv));
    vN = normalize(cross(vT, vB));
    vec3 at = uCenter + turn(p * uSize);
    vV = normalize(uEye - at);
    // The key light: above, a little to the left of the camera and in front of the clock
    vL = normalize(vV * 0.5 + vec3(0.0, 0.8, 0.0) + cross(vec3(0.0, 1.0, 0.0), vV) * 0.35);
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
  varying vec3 vN;
  varying vec3 vT;
  varying vec3 vB;
  varying vec3 vL;
  varying vec3 vV;

  const float TAU = 6.2831853;

  float segment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
  }
  vec2 hand(float turns) {
    float a = turns * TAU;
    return vec2(sin(a), cos(a));
  }
  // Distance to the hands (the second hand apart), at the clock's time t
  float hands(vec2 p, float t) {
    float d = segment(p, vec2(0.0), hand(t / 12.0) * 0.40) - 0.035;
    return min(d, segment(p, vec2(0.0), hand(t) * 0.62) - 0.025);
  }

  void main() {
    // The clock face on the plane's uv: a circle, a touch taller than wide (it melts down)
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    float aa = fwidth(r) * 1.5;
    float disc = 1.0 - smoothstep(0.96 - aa, 0.96 + aa, r);
    if (disc < 0.01) discard;
    vec2 radial = r > 0.0001 ? p / r : vec2(0.0);

    // The shape: a raised rim round a face under a shallow dome of glass
    float rt = clamp((r - 0.76) / 0.20, 0.0, 1.0);
    float slope = r < 0.76 ? -r * 0.35 : 1.6 * cos(rt * 3.14159); // -dh/dr
    vec3 n = normalize(vN + slope * (radial.x * vT + radial.y * vB));
    if (!gl_FrontFacing) n = -n;

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

    // The face sits down in the rim: shadowed under its edge, lit toward the light
    col *= 1.0 - 0.28 * (1.0 - smoothstep(0.62, 0.80, r)) * smoothstep(0.60, 0.80, r) * 1.6;

    // The hands, running backwards at uPace turns a minute, standing off the face and shadowing it
    float t = uTime / 60.0 * uPace;
    vec2 shade = vec2(0.05, -0.07);
    float shadow = 1.0 - smoothstep(0.0, 0.05, hands(p - shade, t));
    col *= 1.0 - 0.38 * shadow * (1.0 - rim);
    col = mix(col, uRim * 0.45, 1.0 - smoothstep(0.0, 0.012, hands(p, t)));
    float sec = segment(p, hand(t * 60.0) * -0.12, hand(t * 60.0) * 0.68) - 0.008;
    col *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.03, segment(p - shade, hand(t * 60.0) * -0.12, hand(t * 60.0) * 0.68) - 0.008)) * (1.0 - rim);
    col = mix(col, vec3(1.0, 0.42, 0.55), 1.0 - smoothstep(0.0, 0.01, sec));
    col = mix(col, uRim * 0.45, 1.0 - smoothstep(0.045, 0.05, r));

    // Light: soft wrap shading, a glint off the rim and the glass, the edge going dark
    float ndl = dot(n, vL);
    float shade2 = 0.58 + 0.42 * clamp(ndl * 0.5 + 0.5, 0.0, 1.0) * 1.25;
    vec3 h = normalize(vL + vV);
    float spec = pow(max(dot(n, h), 0.0), mix(28.0, 70.0, rim));
    col *= shade2;
    col += vec3(1.0, 0.97, 0.9) * spec * mix(0.35, 0.7, rim);
    float fres = pow(1.0 - max(dot(n, vV), 0.0), 3.0);
    col = mix(col, uRim * 0.6, fres * 0.35);
    // The rim's outer edge: the wall of the case, in shade
    col *= 1.0 - 0.45 * smoothstep(0.935, 0.965, r);

    gl_FragColor = vec4(col, disc * 0.97);
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
          uYaw: { value: 0 },
          uSize: { value: c.size },
          uCenter: { value: new Vector3() },
          uEye: { value: new Vector3() },
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
      const yaw = Math.atan2(eye.x - c.at.x, eye.z - c.at.z)
      c.holder.rotation.y = yaw
      const u = c.material.uniforms
      u.uYaw!.value = yaw
      ;(u.uCenter!.value as Vector3).copy(c.holder.position)
      ;(u.uEye!.value as Vector3).copy(eye)
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
