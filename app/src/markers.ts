import { program, loadImage, texture, sharedTexture } from './gl';
import type { Icons, Layer } from './types';

const FS = `#version 300 es
precision highp float;
uniform sampler2D u_atlas;
uniform vec2 u_grid;
in vec2 v_cell;
in float v_alpha;
out vec4 o;
void main() {
  o = texture(u_atlas, (v_cell + gl_PointCoord) / u_grid) * v_alpha;
}`;

const CELL = `float cell(float w) {
  float icon = floor(w + 0.0001);
  float s = min(1.0, (1.0 - (w - icon) / 0.99) / 0.35);
  v_cell = vec2(mod(icon, u_cols), floor(icon / u_cols));
  v_alpha = 0.25 + 0.75 * s;
  return s;
}`;

const VS2 = `#version 300 es
layout(location = 0) in vec4 a_pos;
uniform vec4 u_view;
uniform float u_size;
uniform float u_cols;
out vec2 v_cell;
out float v_alpha;
${CELL}
void main() {
  gl_Position = vec4((a_pos.x - u_view.x) * u_view.z, -(a_pos.y - u_view.y) * u_view.w, 0.0, 1.0);
  float s = cell(a_pos.w);
  gl_PointSize = u_size * (0.7 + 0.3 * s);
}`;

const VS3 = `#version 300 es
layout(location = 0) in vec4 a_pos;
uniform mat4 u_vp;
uniform float u_ex;
uniform float u_size;
uniform float u_cols;
uniform float u_lift;
out vec2 v_cell;
out float v_alpha;
${CELL}
void main() {
  vec4 c = u_vp * vec4(a_pos.x, a_pos.z * u_ex, a_pos.y, 1.0);
  c.y += u_lift * c.w;
  gl_Position = c;
  float s = cell(a_pos.w);
  gl_PointSize = u_size * (0.7 + 0.3 * s);
}`;

interface Buf { vao: WebGLVertexArrayObject; count: number }

export class Markers {
  readonly p2: WebGLProgram;
  readonly p3: WebGLProgram;
  private atlas?: WebGLTexture;
  private bufs = new Map<string, Buf>();
  private owned: [WebGLVertexArrayObject, WebGLBuffer][] = [];
  private disposed = false;
  private one: Buf;
  private oneBuf: WebGLBuffer;
  private prog!: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};

  constructor(private gl: WebGL2RenderingContext, private icons: Icons, layers: Layer[], redraw: () => void) {
    this.p2 = program(gl, VS2, FS);
    this.p3 = program(gl, VS3, FS);
    for (const L of layers) {
      const arr = new Float32Array(L.points.length * 4);
      L.points.forEach((p, i) => arr.set([p.x, p.y, p.z, (p.icon ?? L.icon) + (p.c === undefined ? 0 : (1 - p.c) * 0.99)], i * 4));
      this.bufs.set(L.id, this.vao(arr, gl.STATIC_DRAW)[0]);
    }
    [this.one, this.oneBuf] = this.vao(new Float32Array(4), gl.DYNAMIC_DRAW);
    sharedTexture(gl, icons.file, () => loadImage(icons.file).then((img) => texture(gl, img))).then((t) => { if (!this.disposed) { this.atlas = t; redraw(); } });
  }

  private vao(arr: Float32Array, usage: number): [Buf, WebGLBuffer] {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const b = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, arr, usage);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.owned.push([vao, b]);
    return [{ vao, count: arr.length / 4 }, b];
  }

  private use(p: WebGLProgram): boolean {
    if (!this.atlas) return false;
    const gl = this.gl;
    this.prog = p;
    gl.useProgram(p);
    for (const n of ['u_view', 'u_vp', 'u_ex', 'u_size', 'u_cols', 'u_lift', 'u_grid', 'u_atlas']) this.u[n] = gl.getUniformLocation(p, n);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.uniform1i(this.u.u_atlas, 0);
    gl.uniform2f(this.u.u_grid, this.icons.cols, this.icons.rows);
    gl.uniform1f(this.u.u_cols, this.icons.cols);
    return true;
  }

  begin2d(view: number[]): boolean {
    if (!this.use(this.p2)) return false;
    this.gl.uniform4fv(this.u.u_view, view);
    return true;
  }

  begin3d(vp: Float32Array, ex: number): boolean {
    if (!this.use(this.p3)) return false;
    this.gl.uniformMatrix4fv(this.u.u_vp, false, vp);
    this.gl.uniform1f(this.u.u_ex, ex);
    return true;
  }

  private size(px: number, lift: number) {
    this.gl.uniform1f(this.u.u_size, px);
    if (this.prog === this.p3) this.gl.uniform1f(this.u.u_lift, lift);
  }

  layer(id: string, px: number, lift = 0) {
    const b = this.bufs.get(id);
    if (!b || !b.count) return;
    this.size(px, lift);
    this.gl.bindVertexArray(b.vao);
    this.gl.drawArrays(this.gl.POINTS, 0, b.count);
  }

  single(x: number, y: number, z: number, icon: number, px: number, lift = 0) {
    const gl = this.gl;
    this.size(px, lift);
    gl.bindVertexArray(this.one.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.oneBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array([x, y, z, icon]));
    gl.drawArrays(gl.POINTS, 0, 1);
  }

  end() { this.gl.bindVertexArray(null); }

  dispose() {
    this.disposed = true;
    this.atlas = undefined;
    for (const [v, b] of this.owned) { this.gl.deleteVertexArray(v); this.gl.deleteBuffer(b); }
    this.owned = [];
  }
}
