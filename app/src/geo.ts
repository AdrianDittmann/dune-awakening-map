import { program, loadImage } from './gl';
import { binary, json } from './data';
import { MAP_M } from './coords';

interface GLod { v: number; n: number; i: number; c: number; min: number[]; scale: number[] }
interface GMesh { name: string; mat: number; lods: GLod[]; ctr: number[]; r: number }
interface GMeta { vbytes: number; ibytes: number; count: number; cell: number; chunks: string[]; meshes: GMesh[]; fixed?: number[]; sets?: number[][]; place?: Record<string, number[][]> }

export const LIGHT = `
const vec3 SUN = vec3(0.5726, 0.3879, 0.5726);
vec3 shade(vec3 base, vec3 n, vec3 w, vec3 eye, float span) {
  float l = max(dot(n, SUN), 0.0);
  vec3 sky = mix(vec3(0.42, 0.36, 0.30), vec3(0.55, 0.56, 0.58), n.y * 0.5 + 0.5);
  vec3 c = base * (sky * 0.78 + vec3(1.0, 0.94, 0.84) * l * 0.95);
  float f = 1.0 - exp(-distance(w, eye) / (span * 1.1));
  return mix(c, vec3(0.80, 0.70, 0.58), f * 0.55);
}`;

const VS = `#version 300 es
in vec3 a_pos;
in vec4 a_r0;
in vec4 a_r1;
in vec4 a_r2;
uniform vec3 u_min;
uniform vec3 u_scale;
uniform mat4 u_vp;
uniform float u_ex;
out vec3 v_map;
out vec3 v_w;
void main() {
  vec4 l = vec4(u_min + (a_pos * 0.5 + 0.5) * u_scale, 1.0);
  vec3 m = vec3(dot(a_r0, l), dot(a_r1, l), dot(a_r2, l));
  v_map = m;
  v_w = vec3(m.x, m.z * u_ex, m.y);
  gl_Position = u_vp * vec4(v_w, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D u_red;
uniform sampler2D u_rad;
uniform int u_mat;
uniform vec3 u_eye;
uniform float u_span;
in vec3 v_map;
in vec3 v_w;
out vec4 o;
${LIGHT}
void main() {
  vec3 n = normalize(cross(dFdx(v_w), dFdy(v_w)));
  vec2 uv = v_map.xy / 10160.0 + 0.0503937;
  vec3 base;
  if (u_mat == 0) {
    float h = clamp(n.y * 0.6 + 0.4, 0.0, 1.0);
    vec3 rock = mix(vec3(0.50, 0.40, 0.31), vec3(0.78, 0.66, 0.52), h);
    vec3 red = mix(vec3(0.52, 0.27, 0.15), vec3(0.80, 0.52, 0.34), h);
    base = mix(rock, red, texture(u_red, uv).r);
  } else if (u_mat == 3) {
    base = vec3(0.60, 0.62, 0.63);
  } else if (u_mat == 2) {
    base = vec3(0.66, 0.60, 0.52);
  } else {
    base = vec3(0.58, 0.56, 0.53);
  }
  base += 0.3 * texture(u_rad, uv).r * (vec3(0.80, 0.84, 0.56) - base);
  o = vec4(shade(base, n, v_w, u_eye, u_span), 1.0);
}`;

interface Lib { meta: GMeta; all: Uint8Array; T: Float32Array; R: Float32Array; MI: Uint16Array }
const libs = new Map<string, Promise<Lib>>();
let halfs: Float32Array | undefined;

function half(): Float32Array {
  if (halfs) return halfs;
  halfs = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
    halfs[h] = e === 0 ? s * f * 5.960464477539063e-8 : e === 31 ? s * Infinity : s * (1 + f / 1024) * 2 ** (e - 15);
  }
  return halfs;
}

function library(url: string): Promise<Lib> {
  let p = libs.get(url);
  if (!p) {
    p = (async () => {
      const meta = await json<GMeta>(url);
      const parts = await Promise.all(meta.chunks.map((c) => binary(`./data/${c}`)));
      const all = new Uint8Array(parts.reduce((a, q) => a + q.length, 0));
      let at = 0;
      for (const q of parts) { all.set(q, at); at += q.length; }
      const nr = meta.count, dv = new DataView(all.buffer, meta.vbytes + meta.ibytes, nr * 32), hf = half();
      const T = new Float32Array(nr * 3), R = new Float32Array(nr * 9), MI = new Uint16Array(nr);
      for (let k = 0; k < nr; k++) {
        const o = k * 32;
        T[k * 3] = dv.getFloat32(o, true); T[k * 3 + 1] = dv.getFloat32(o + 4, true); T[k * 3 + 2] = dv.getFloat32(o + 8, true);
        for (let j = 0; j < 9; j++) R[k * 9 + j] = hf[dv.getUint16(o + 12 + j * 2, true)];
        MI[k] = dv.getUint16(o + 30, true);
      }
      return { meta, all, T, R, MI };
    })();
    libs.set(url, p);
    p.catch(() => libs.delete(url));
  }
  return p;
}

export class Geo {
  ready = false;
  drawn = 0;
  private disposed = false;
  private meta!: GMeta;
  private rows!: Float32Array;
  private sph!: Float32Array;
  private cells: number[][] = [];
  private mesh!: Uint16Array;
  private stage!: Float32Array;
  private pick!: Int32Array;
  private vbo!: WebGLBuffer;
  private ibo!: WebGLBuffer;
  private ibuf!: WebGLBuffer;
  private vao!: WebGLVertexArrayObject;
  private prog: WebGLProgram;
  private red?: WebGLTexture;
  private rad?: WebGLTexture;
  private loc: Record<string, number> = {};
  private u: Record<string, WebGLUniformLocation | null> = {};

  constructor(private gl: WebGL2RenderingContext) {
    this.prog = program(gl, VS, FS);
    for (const a of ['a_pos', 'a_r0', 'a_r1', 'a_r2']) this.loc[a] = gl.getAttribLocation(this.prog, a);
    for (const n of ['u_min', 'u_scale', 'u_vp', 'u_ex', 'u_mat', 'u_red', 'u_rad', 'u_eye', 'u_span']) this.u[n] = gl.getUniformLocation(this.prog, n);
  }

  async load(url: string, onReady: () => void, opts: { layout?: number; masks?: boolean } = {}) {
    const gl = this.gl, masks = opts.masks !== false;
    const [lib, red, rad] = await Promise.all([
      library(url),
      masks ? loadImage('./data/redness_mask.png') : null,
      masks ? loadImage('./data/radiation_mask.png') : null,
    ]);
    if (this.disposed) return;
    const { meta, all, T, R, MI } = lib;
    this.meta = meta;
    const runs: number[][] = meta.sets && meta.place && meta.fixed
      ? [[meta.fixed[0], meta.fixed[1], 0, 0, 0, 0], ...(meta.place[String(opts.layout ?? 0).padStart(2, '0')] ?? []).map(([s, x, y, z, yaw]) => [meta.sets![s][0], meta.sets![s][1], x, y, z, yaw])]
      : [[0, meta.count, 0, 0, 0, 0]];
    const n = runs.reduce((a, r) => a + r[1], 0), cs = meta.cell, nc = Math.max(1, Math.ceil(MAP_M / cs));
    const rows = new Float32Array(n * 12), sph = new Float32Array(n * 4), mesh = new Uint16Array(n), cell = new Int32Array(n);
    let k = 0;
    for (const [start, count, X, Y, Z, yaw] of runs) {
      const a = (yaw * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      for (let i = start; i < start + count; i++, k++) {
        const t = i * 3, r = i * 9, M = meta.meshes[MI[i]], ct = M.ctr;
        const x0 = R[r] * c - R[r + 1] * s, y0 = R[r] * s + R[r + 1] * c, z0 = R[r + 2];
        const x1 = R[r + 3] * c - R[r + 4] * s, y1 = R[r + 3] * s + R[r + 4] * c, z1 = R[r + 5];
        const x2 = R[r + 6] * c - R[r + 7] * s, y2 = R[r + 6] * s + R[r + 7] * c, z2 = R[r + 8];
        const wx = T[t] * c - T[t + 1] * s + X, wy = T[t] * s + T[t + 1] * c + Y, wz = T[t + 2] + Z;
        const o = k * 12, b = k * 4;
        rows[o] = x0; rows[o + 1] = x1; rows[o + 2] = x2; rows[o + 3] = wx;
        rows[o + 4] = y0; rows[o + 5] = y1; rows[o + 6] = y2; rows[o + 7] = wy;
        rows[o + 8] = z0; rows[o + 9] = z1; rows[o + 10] = z2; rows[o + 11] = wz;
        const cx = x0 * ct[0] + x1 * ct[1] + x2 * ct[2] + wx;
        const cy = y0 * ct[0] + y1 * ct[1] + y2 * ct[2] + wy;
        sph[b] = cx; sph[b + 1] = cy; sph[b + 2] = z0 * ct[0] + z1 * ct[1] + z2 * ct[2] + wz;
        sph[b + 3] = M.r * Math.sqrt(Math.max(x0 * x0 + y0 * y0 + z0 * z0, x1 * x1 + y1 * y1 + z1 * z1, x2 * x2 + y2 * y2 + z2 * z2));
        mesh[k] = MI[i];
        cell[k] = Math.min(nc - 1, Math.max(0, Math.floor(cy / cs))) * nc + Math.min(nc - 1, Math.max(0, Math.floor(cx / cs)));
      }
    }
    const cnt = new Int32Array(nc * nc + 1);
    for (let j = 0; j < n; j++) cnt[cell[j] + 1]++;
    for (let j = 0; j < nc * nc; j++) cnt[j + 1] += cnt[j];
    const pos = cnt.slice(0, nc * nc);
    this.rows = new Float32Array(n * 12);
    this.sph = new Float32Array(n * 4);
    this.mesh = new Uint16Array(n);
    for (let j = 0; j < n; j++) {
      const d = pos[cell[j]]++;
      for (let q = 0; q < 12; q++) this.rows[d * 12 + q] = rows[j * 12 + q];
      for (let q = 0; q < 4; q++) this.sph[d * 4 + q] = sph[j * 4 + q];
      this.mesh[d] = mesh[j];
    }
    this.cells = [];
    for (let j = 0; j < nc * nc; j++) {
      const a = cnt[j], b = cnt[j + 1];
      if (a === b) continue;
      let lo = Infinity, hi = -Infinity, rmax = 0;
      for (let e = a; e < b; e++) {
        const z = this.sph[e * 4 + 2], r = this.sph[e * 4 + 3];
        lo = Math.min(lo, z - r); hi = Math.max(hi, z + r); rmax = Math.max(rmax, r);
      }
      this.cells.push([(j % nc) * cs, Math.floor(j / nc) * cs, lo, hi, rmax, a, b - a]);
    }
    this.stage = new Float32Array(n * 12);
    this.pick = new Int32Array(n);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(all.buffer, 0, meta.vbytes), gl.STATIC_DRAW);
    this.ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint8Array(all.buffer, meta.vbytes, meta.ibytes), gl.STATIC_DRAW);
    this.ibuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.stage.byteLength, gl.DYNAMIC_DRAW);
    for (const a of ['a_r0', 'a_r1', 'a_r2']) { gl.enableVertexAttribArray(this.loc[a]); gl.vertexAttribDivisor(this.loc[a], 1); }
    gl.enableVertexAttribArray(this.loc.a_pos);
    gl.bindVertexArray(null);
    const mask = (img: HTMLImageElement | null) => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      if (img) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.red = mask(red);
    this.rad = mask(rad);
    this.ready = true;
    onReady();
  }

  dispose() {
    const gl = this.gl;
    this.disposed = true;
    this.ready = false;
    if (this.vao) gl.deleteVertexArray(this.vao);
    for (const b of [this.vbo, this.ibo, this.ibuf]) if (b) gl.deleteBuffer(b);
    for (const t of [this.red, this.rad]) if (t) gl.deleteTexture(t);
  }

  draw(vp: Float32Array, eye: number[], ex: number, focal: number, span: number) {
    if (!this.ready) return;
    const gl = this.gl, M = this.meta, rows = this.rows, sph = this.sph, stage = this.stage, pick = this.pick;
    const planes: number[][] = [];
    const row = (i: number) => [vp[i], vp[4 + i], vp[8 + i], vp[12 + i]];
    const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
    for (const [a, s] of [[r0, 1], [r0, -1], [r1, 1], [r1, -1], [r2, 1], [r2, -1]] as [number[], number][]) {
      const p = [r3[0] + s * a[0], r3[1] + s * a[1], r3[2] + s * a[2], r3[3] + s * a[3]];
      const len = Math.hypot(p[0], p[1], p[2]);
      planes.push(p.map((x) => x / len));
    }
    const ey = Math.max(ex, 1), nm = M.meshes.length, counts = new Int32Array(nm * 3);
    let vis = 0;
    for (const c of this.cells) {
      const cxm = c[0] + M.cell / 2, cym = c[1] + M.cell / 2, czm = (c[2] + c[3]) / 2 * ex;
      const rad = Math.hypot(M.cell / 2, M.cell / 2, (c[3] - c[2]) / 2 * ey) + c[4];
      let inside = true;
      for (const p of planes) if (p[0] * cxm + p[1] * czm + p[2] * cym + p[3] < -rad) { inside = false; break; }
      if (!inside) continue;
      const dc = Math.max(1, Math.hypot(cxm - eye[0], czm - eye[1], cym - eye[2]) - rad);
      if ((c[4] * focal) / dc < 1.5) continue;
      for (let k = c[5], e = c[5] + c[6]; k < e; k++) {
        const b = k * 4, x = sph[b], y = sph[b + 2] * ex, z = sph[b + 1], r = sph[b + 3] * ey;
        let ok = true;
        for (const p of planes) if (p[0] * x + p[1] * y + p[2] * z + p[3] < -r) { ok = false; break; }
        if (!ok) continue;
        const d = Math.max(1, Math.hypot(x - eye[0], y - eye[1], z - eye[2]) - r), s = (r * focal) / d;
        if (s < 1.5) continue;
        const m = this.mesh[k], nl = M.meshes[m].lods.length;
        const lod = Math.min(nl - 1, s > 160 ? 0 : s > 40 ? 1 : 2);
        pick[vis++] = k * 4 + lod;
        counts[m * 3 + lod]++;
      }
    }
    const starts = new Int32Array(nm * 3);
    let acc = 0;
    for (let i = 0; i < nm * 3; i++) { starts[i] = acc; acc += counts[i]; }
    const fill = starts.slice();
    for (let j = 0; j < vis; j++) {
      const k = pick[j] >> 2, lod = pick[j] & 3, slot = fill[this.mesh[k] * 3 + lod]++;
      stage.set(rows.subarray(k * 12, k * 12 + 12), slot * 12);
    }
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, stage, 0, acc * 12);
    gl.uniformMatrix4fv(this.u.u_vp, false, vp);
    gl.uniform1f(this.u.u_ex, ex);
    gl.uniform3fv(this.u.u_eye, eye);
    gl.uniform1f(this.u.u_span, span);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.red!);
    gl.uniform1i(this.u.u_red, 2);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.rad!);
    gl.uniform1i(this.u.u_rad, 3);
    gl.activeTexture(gl.TEXTURE0);
    let tris = 0;
    for (let i = 0; i < nm * 3; i++) {
      const cnt = counts[i];
      if (!cnt) continue;
      const mesh = M.meshes[(i / 3) | 0], L = mesh.lods[i % 3];
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.vertexAttribPointer(this.loc.a_pos, 3, gl.SHORT, true, 8, L.v);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
      const base = starts[i] * 48;
      gl.vertexAttribPointer(this.loc.a_r0, 4, gl.FLOAT, false, 48, base);
      gl.vertexAttribPointer(this.loc.a_r1, 4, gl.FLOAT, false, 48, base + 16);
      gl.vertexAttribPointer(this.loc.a_r2, 4, gl.FLOAT, false, 48, base + 32);
      gl.uniform3fv(this.u.u_min, L.min);
      gl.uniform3fv(this.u.u_scale, L.scale);
      gl.uniform1i(this.u.u_mat, mesh.mat);
      gl.drawElementsInstanced(gl.TRIANGLES, L.c, gl.UNSIGNED_SHORT, L.i, cnt);
      tris += (L.c / 3) * cnt;
    }
    this.drawn = tris;
    gl.bindVertexArray(null);
  }
}
