import { program, type TileSource } from './gl';
import { MAP_M, Terrain } from './coords';
import type { Layer, MapData, Pick } from './types';
import type { Markers } from './markers';
import { Geo } from './geo';

const TERRAIN_VS = `#version 300 es
uniform sampler2D u_h;
uniform mat4 u_vp;
uniform float u_ex;
uniform float u_n;
uniform float u_size;
out vec2 v_uv;
out vec3 v_nrm;
out vec3 v_w;
void main() {
  float n = u_n;
  int id = gl_VertexID;
  vec2 g = vec2(float(id % int(n)), float(id / int(n))) / (n - 1.0);
  vec2 texel = 1.0 / vec2(textureSize(u_h, 0));
  float h = texture(u_h, g).r;
  float hx = texture(u_h, g + vec2(texel.x, 0.0)).r - texture(u_h, g - vec2(texel.x, 0.0)).r;
  float hy = texture(u_h, g + vec2(0.0, texel.y)).r - texture(u_h, g - vec2(0.0, texel.y)).r;
  float span = 2.0 * u_size * texel.x;
  v_nrm = normalize(vec3(-hx * u_ex / span, 1.0, -hy * u_ex / span));
  v_uv = g;
  v_w = vec3(g.x * u_size, h * u_ex, g.y * u_size);
  gl_Position = u_vp * vec4(v_w, 1.0);
}`;

const TERRAIN_FS = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec3 u_eye;
uniform float u_size;
in vec2 v_uv;
in vec3 v_nrm;
in vec3 v_w;
out vec4 o;
void main() {
  vec3 base = texture(u_tex, v_uv).rgb;
  float l = max(dot(normalize(v_nrm), vec3(0.5726, 0.3879, 0.5726)), 0.0);
  vec3 c = base * (0.84 + 0.26 * l);
  float f = 1.0 - exp(-distance(v_w, u_eye) / (u_size * 1.1));
  o = vec4(mix(c, vec3(0.80, 0.70, 0.58), f * 0.55), 1.0);
}`;

type M4 = Float32Array;
function mul(a: M4, b: M4): M4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
function persp(fov: number, asp: number, n: number, f: number): M4 {
  const t = 1 / Math.tan(fov / 2), o = new Float32Array(16);
  o[0] = t / asp; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = (2 * f * n) / (n - f);
  return o;
}
function lookAt(e: number[], c: number[]): M4 {
  const z = norm([e[0] - c[0], e[1] - c[1], e[2] - c[2]]);
  const x = norm(cross([0, 1, 0], z));
  const y = cross(z, x);
  const o = new Float32Array(16);
  o.set([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, e), -dot(y, e), -dot(z, e), 1]);
  return o;
}
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };

export class View3D {
  tx = MAP_M / 2;
  ty = MAP_M / 2;
  dist = MAP_M * 0.935;
  yaw = 0.35;
  pitch = 0.62;
  ex = 1;
  w = 1;
  h = 1;
  dpr = 1;
  layers = new Set<string>();
  selected: Pick | null = null;
  pin: { x: number; y: number } | null = null;
  private vp: M4 = new Float32Array(16);
  private tProg!: WebGLProgram;
  private hTex!: WebGLTexture;
  private drape!: WebGLTexture;
  private idx!: WebGLBuffer;
  private nIdx = 0;
  private emptyVao!: WebGLVertexArrayObject;
  private inited = false;
  private order: Layer[];
  private pending = 0;
  private eye = [0, 0, 0];
  readonly geo: Geo;
  private grid: number;
  private disposed = false;

  constructor(private gl: WebGL2RenderingContext, private data: MapData, private terrain: Terrain, private all: Layer[], private markers: Markers, private src: TileSource, private redraw: () => void) {
    this.grid = data.world === 'dd' ? 1017 : 509;
    this.geo = new Geo(gl);
    this.order = [...all].sort((a, b) => a.size - b.size);
  }

  private init() {
    const gl = this.gl, GRID = this.grid, terrain = this.terrain;
    this.tProg = program(gl, TERRAIN_VS, TERRAIN_FS);
    this.hTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.hTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, terrain.n, terrain.n, 0, gl.RED, gl.FLOAT, terrain.h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const ind = new Uint32Array((GRID - 1) * (GRID - 1) * 6);
    let k = 0;
    for (let r = 0; r < GRID - 1; r++) for (let c = 0; c < GRID - 1; c++) {
      const a = r * GRID + c, b = a + 1, d = a + GRID, e = d + 1;
      ind[k++] = a; ind[k++] = d; ind[k++] = b; ind[k++] = b; ind[k++] = d; ind[k++] = e;
    }
    this.nIdx = k;
    this.emptyVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.emptyVao);
    this.idx = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ind, gl.STATIC_DRAW);
    const size = 4096;
    this.drape = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.drape);
    gl.texStorage2D(gl.TEXTURE_2D, 1 + Math.log2(size), gl.RGBA8, size, size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindVertexArray(null);
    this.inited = true;
  }

  loadDrape() {
    if (!this.inited) this.init();
    const dd = this.data.world === 'dd', n2 = String(this.data.layout ?? 0).padStart(2, '0');
    this.geo.load(dd ? './data/geo/dd.json' : './data/geo/hagga.json', this.redraw, { layout: +n2, masks: !dd });
    const t = this.data.tiles.tile, n = 4096 / t, z = Math.round(Math.log2(n)), gl = this.gl;
    this.pending = n * n;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      this.src.tile(z, x, y).then((img) => {
        if (!this.disposed) {
          gl.bindTexture(gl.TEXTURE_2D, this.drape);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, x * t, y * t, gl.RGBA, gl.UNSIGNED_BYTE, img);
          if (--this.pending === 0) gl.generateMipmap(gl.TEXTURE_2D);
          this.redraw();
        }
        img.close();
      });
    }
  }

  dispose() {
    const gl = this.gl;
    this.disposed = true;
    this.geo.dispose();
    if (!this.inited) return;
    gl.deleteTexture(this.hTex);
    gl.deleteTexture(this.drape);
    gl.deleteBuffer(this.idx);
    gl.deleteVertexArray(this.emptyVao);
  }

  resize(w: number, h: number, dpr: number) {
    if (w < 2 || h < 2) return;
    this.w = w; this.h = h; this.dpr = dpr;
  }

  focus(x: number, y: number) { this.tx = x; this.ty = y; }

  orbit(dx: number, dy: number) {
    this.yaw -= dx * 0.005;
    this.pitch = Math.min(1.45, Math.max(0.12, this.pitch + dy * 0.004));
  }

  pan(dx: number, dy: number) {
    const s = (this.dist / this.h) * 0.9;
    const c = Math.cos(this.yaw), si = Math.sin(this.yaw);
    this.tx = Math.min(Math.max(this.tx - (dx * c + dy * si) * s, 0), MAP_M);
    this.ty = Math.min(Math.max(this.ty + (dx * si - dy * c) * s, 0), MAP_M);
  }

  zoom(f: number) { this.dist = Math.min(Math.max(this.dist * f, 150), MAP_M * 1.72); }

  private matrix(): M4 {
    const th = this.terrain.at(this.tx, this.ty) * this.ex;
    const e = [this.tx + this.dist * Math.cos(this.pitch) * Math.sin(this.yaw), th + this.dist * Math.sin(this.pitch), this.ty + this.dist * Math.cos(this.pitch) * Math.cos(this.yaw)];
    this.eye = e;
    const p = persp(0.75, this.w / this.h, Math.max(5, this.dist * 0.02), this.dist * 6 + MAP_M * 1.5);
    return mul(p, lookAt(e, [this.tx, th, this.ty]));
  }

  project(x: number, y: number, z: number): [number, number, number] {
    const m = this.vp;
    const X = x, Y = z * this.ex, Z = y;
    const cx = m[0] * X + m[4] * Y + m[8] * Z + m[12];
    const cy = m[1] * X + m[5] * Y + m[9] * Z + m[13];
    const cw = m[3] * X + m[7] * Y + m[11] * Z + m[15];
    return [(cx / cw * 0.5 + 0.5) * this.w, (1 - (cy / cw * 0.5 + 0.5)) * this.h, cw];
  }

  private px(L: Layer) { return L.size * 0.9; }

  screenOf(L: Layer, i: number): [number, number, number] {
    const p = L.points[i], s = this.px(L), [x, y] = this.project(p.x, p.y, p.z);
    return [x, y - s / 2 - 3, s / 2];
  }

  pick(sx: number, sy: number): Pick | null {
    let best: Pick | null = null, bd = Infinity;
    for (const L of this.order) {
      if (!this.layers.has(L.id) || L.hidden) continue;
      const s = this.px(L), r = Math.max(10, s / 2 + 2);
      L.points.forEach((p, i) => {
        const [px, py, w] = this.project(p.x, p.y, p.z);
        if (w <= 0) return;
        const d = (px - sx) ** 2 + (py - s / 2 - 3 - sy) ** 2;
        if (d < r * r && d <= bd) { bd = d; best = { layer: L.id, index: i }; }
      });
    }
    return best;
  }

  draw() {
    const gl = this.gl;
    if (!this.inited) return;
    this.vp = this.matrix();
    gl.viewport(0, 0, Math.round(this.w * this.dpr), Math.round(this.h * this.dpr));
    gl.clearColor(0.09, 0.075, 0.06, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.tProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.tProg, 'u_vp'), false, this.vp);
    gl.uniform1f(gl.getUniformLocation(this.tProg, 'u_ex'), this.ex);
    gl.uniform1f(gl.getUniformLocation(this.tProg, 'u_n'), this.grid);
    gl.uniform1f(gl.getUniformLocation(this.tProg, 'u_size'), MAP_M);
    gl.uniform3fv(gl.getUniformLocation(this.tProg, 'u_eye'), this.eye);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.hTex);
    gl.uniform1i(gl.getUniformLocation(this.tProg, 'u_h'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.drape);
    gl.uniform1i(gl.getUniformLocation(this.tProg, 'u_tex'), 1);
    gl.bindVertexArray(this.emptyVao);
    gl.drawElements(gl.TRIANGLES, this.nIdx, gl.UNSIGNED_INT, 0);
    gl.activeTexture(gl.TEXTURE0);
    this.geo.draw(this.vp, this.eye, this.ex, this.h / (2 * Math.tan(0.375)), MAP_M);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const m = this.markers, d = this.dpr, H = this.h * d;
    const lift = (px: number) => (px / 2 + 3 * d) * 2 / H;
    if (m.begin3d(this.vp, this.ex)) {
      for (const L of this.order) if (this.layers.has(L.id) && !L.hidden) { const px = this.px(L) * d; m.layer(L.id, px, lift(px)); }
      if (this.pin) { const px = 30 * d; m.single(this.pin.x, this.pin.y, this.terrain.at(this.pin.x, this.pin.y), this.data.icons.pin, px, lift(px)); }
      if (this.selected) {
        const L = this.all.find((l) => l.id === this.selected!.layer);
        const p = L?.points[this.selected.index];
        if (L && p) { const px = Math.max(30, L.size * 1.45) * d; m.single(p.x, p.y, p.z, p.icon ?? L.icon, px, lift(px)); }
      }
      m.end();
    }
    gl.bindVertexArray(null);
  }
}
