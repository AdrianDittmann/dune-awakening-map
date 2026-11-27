import { program, loadImage, texture, type TileSource } from './gl';
import { MAP_M, SECTOR_M } from './coords';
import type { Markers } from './markers';
import type { Layer, MapData, Pick } from './types';

const QUAD_VS = `#version 300 es
in vec2 a;
uniform vec4 u_rect;
uniform vec4 u_view;
out vec2 v_uv;
void main() {
  vec2 w = u_rect.xy + a * u_rect.zw;
  gl_Position = vec4((w.x - u_view.x) * u_view.z, -(w.y - u_view.y) * u_view.w, 0.0, 1.0);
  v_uv = a;
}`;

const QUAD_FS = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform float u_alpha;
in vec2 v_uv;
out vec4 o;
void main() { o = texture(u_tex, v_uv) * u_alpha; }`;

const LINE_VS = `#version 300 es
in vec2 a;
uniform vec4 u_view;
void main() { gl_Position = vec4((a.x - u_view.x) * u_view.z, -(a.y - u_view.y) * u_view.w, 0.0, 1.0); }`;

const LINE_FS = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 o;
void main() { o = u_color; }`;

interface Tile { tex?: WebGLTexture; loading: boolean; z: number; used: number }
const KEEP_TILES = 40;

export class Map2D {
  cx = MAP_M / 2;
  cy = MAP_M / 2;
  ppm = 0.1;
  w = 1;
  h = 1;
  dpr = 1;
  layers = new Set<string>();
  overlays = new Map<string, number>();
  selected: Pick | null = null;
  pin: { x: number; y: number } | null = null;
  grid = true;
  private tiles = new Map<string, Tile>();
  private tick = 0;
  private overTex = new Map<string, WebGLTexture | 'loading'>();
  private quadProg: WebGLProgram;
  private lineProg: WebGLProgram;
  private quadVao: WebGLVertexArrayObject;
  private lineVao: WebGLVertexArrayObject;
  private lineCount = 0;
  private buffers: WebGLBuffer[] = [];
  private disposed = false;
  private order: Layer[];

  constructor(private gl: WebGL2RenderingContext, private data: MapData, private all: Layer[], private markers: Markers, private src: TileSource, private redraw: () => void) {
    this.quadProg = program(gl, QUAD_VS, QUAD_FS);
    this.lineProg = program(gl, LINE_VS, LINE_FS);
    this.order = [...all].sort((a, b) => a.size - b.size);
    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    const qb = gl.createBuffer()!;
    this.buffers.push(qb);
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const qa = gl.getAttribLocation(this.quadProg, 'a');
    gl.enableVertexAttribArray(qa);
    gl.vertexAttribPointer(qa, 2, gl.FLOAT, false, 0, 0);
    const lines: number[] = [];
    for (let k = 0; k <= MAP_M / SECTOR_M; k++) {
      const v = k * SECTOR_M;
      lines.push(v, 0, v, MAP_M, 0, v, MAP_M, v);
    }
    this.lineCount = lines.length / 2;
    this.lineVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.lineVao);
    const lb = gl.createBuffer()!;
    this.buffers.push(lb);
    gl.bindBuffer(gl.ARRAY_BUFFER, lb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lines), gl.STATIC_DRAW);
    const la = gl.getAttribLocation(this.lineProg, 'a');
    gl.enableVertexAttribArray(la);
    gl.vertexAttribPointer(la, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  private fitted = false;
  inset = 0;
  insetBottom = 0;

  resize(w: number, h: number, dpr: number) {
    if (w < 2 || h < 2) return;
    this.w = w; this.h = h; this.dpr = dpr;
    if (!this.fitted) {
      this.ppm = (Math.min(w - this.inset, h - this.insetBottom) / MAP_M) * 0.94;
      this.cx = MAP_M / 2 - this.inset / 2 / this.ppm;
      this.cy = MAP_M / 2 + this.insetBottom / 2 / this.ppm;
      this.fitted = true;
    }
  }

  minPpm() { return (Math.min(this.w, this.h) / MAP_M) * 0.6; }

  clamp() {
    this.ppm = Math.min(Math.max(this.ppm, this.minPpm()), 6);
    this.cx = Math.min(Math.max(this.cx, -this.inset / 2 / this.ppm), MAP_M);
    this.cy = Math.min(Math.max(this.cy, 0), MAP_M + this.insetBottom / 2 / this.ppm);
  }

  toWorld(sx: number, sy: number): [number, number] {
    return [this.cx + (sx - this.w / 2) / this.ppm, this.cy + (sy - this.h / 2) / this.ppm];
  }

  toScreen(x: number, y: number): [number, number] {
    return [(x - this.cx) * this.ppm + this.w / 2, (y - this.cy) * this.ppm + this.h / 2];
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const [wx, wy] = this.toWorld(sx, sy);
    this.ppm *= factor;
    this.clamp();
    this.cx = wx - (sx - this.w / 2) / this.ppm;
    this.cy = wy - (sy - this.h / 2) / this.ppm;
    this.clamp();
  }

  pan(dx: number, dy: number) {
    this.cx -= dx / this.ppm;
    this.cy -= dy / this.ppm;
    this.clamp();
  }

  flyTo(x: number, y: number, ppm?: number) {
    this.cx = x; this.cy = y;
    if (ppm) this.ppm = ppm;
    this.clamp();
  }

  screenOf(L: Layer, i: number): [number, number, number] {
    const p = L.points[i], [x, y] = this.toScreen(p.x, p.y);
    return [x, y, (L.size * this.iconScale()) / 2];
  }

  iconScale() {
    return Math.min(1.25, Math.max(0.8, Math.sqrt(this.ppm / ((Math.min(this.w, this.h) / MAP_M) * 1.5))));
  }

  pick(sx: number, sy: number): Pick | null {
    let best: Pick | null = null, bd = Infinity;
    const k = this.iconScale();
    for (const L of this.order) {
      if (!this.layers.has(L.id) || L.hidden) continue;
      const r = Math.max(10, (L.size * k) / 2 + 2), pts = L.points;
      for (let i = 0; i < pts.length; i++) {
        const [px, py] = this.toScreen(pts[i].x, pts[i].y);
        const d = (px - sx) ** 2 + (py - sy) ** 2;
        if (d < r * r && d <= bd) { bd = d; best = { layer: L.id, index: i }; }
      }
    }
    return best;
  }

  private tile(z: number, x: number, y: number): WebGLTexture | undefined {
    const key = `${z}/${x}_${y}`;
    let t = this.tiles.get(key);
    if (!t) {
      t = { loading: true, z, used: this.tick };
      this.tiles.set(key, t);
      const tt = t;
      this.src.tile(z, x, y).then((img) => {
        if (this.disposed || this.tiles.get(key) !== tt) { img.close(); return; }
        tt.tex = texture(this.gl, img);
        img.close();
        tt.loading = false;
        this.redraw();
      }).catch(() => { tt.loading = false; });
    }
    t.used = this.tick;
    return t.tex;
  }

  level(): number {
    return Math.min(this.data.tiles.levels - 1, Math.max(0, Math.ceil(Math.log2((this.ppm * this.dpr * MAP_M) / this.data.tiles.tile))));
  }

  seed(z: number, x: number, y: number, img: ImageBitmap) {
    this.tiles.set(`${z}/${x}_${y}`, { tex: texture(this.gl, img), loading: false, z, used: this.tick });
  }

  dispose() {
    const gl = this.gl;
    this.disposed = true;
    for (const t of this.tiles.values()) if (t.tex) gl.deleteTexture(t.tex);
    for (const t of this.overTex.values()) if (t !== 'loading') gl.deleteTexture(t);
    for (const b of this.buffers) gl.deleteBuffer(b);
    gl.deleteVertexArray(this.quadVao);
    gl.deleteVertexArray(this.lineVao);
    this.tiles.clear();
    this.overTex.clear();
  }

  private evict() {
    if (this.tiles.size <= KEEP_TILES) return;
    const old = [...this.tiles].filter(([, t]) => t.z >= 2 && !t.loading && t.used < this.tick).sort((a, b) => a[1].used - b[1].used);
    for (const [key, t] of old) {
      if (this.tiles.size <= KEEP_TILES) break;
      if (t.tex) this.gl.deleteTexture(t.tex);
      this.tiles.delete(key);
    }
  }

  private overlay(name: string): WebGLTexture | undefined {
    const t = this.overTex.get(name);
    if (t === 'loading') return undefined;
    if (t) return t;
    this.overTex.set(name, 'loading');
    loadImage(`./data/${name}.png`).then((img) => {
      if (this.disposed) return;
      this.overTex.set(name, texture(this.gl, img));
      this.redraw();
    }).catch(() => this.overTex.delete(name));
    return undefined;
  }

  draw() {
    const gl = this.gl;
    this.tick++;
    gl.viewport(0, 0, Math.round(this.w * this.dpr), Math.round(this.h * this.dpr));
    gl.clearColor(0.09, 0.075, 0.06, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    const view = [this.cx, this.cy, (2 * this.ppm) / this.w, (2 * this.ppm) / this.h];
    gl.useProgram(this.quadProg);
    gl.bindVertexArray(this.quadVao);
    gl.uniform4fv(gl.getUniformLocation(this.quadProg, 'u_view'), view);
    const uRect = gl.getUniformLocation(this.quadProg, 'u_rect');
    const uAlpha = gl.getUniformLocation(this.quadProg, 'u_alpha');
    gl.activeTexture(gl.TEXTURE0);
    const want = this.level();
    const [x0, y0] = this.toWorld(0, 0);
    const [x1, y1] = this.toWorld(this.w, this.h);
    gl.uniform1f(uAlpha, 1);
    for (let z = 0; z <= want; z++) {
      const n = 2 ** z, tm = MAP_M / n;
      const a0 = Math.max(0, Math.floor(x0 / tm)), a1 = Math.min(n - 1, Math.floor(x1 / tm));
      const b0 = Math.max(0, Math.floor(y0 / tm)), b1 = Math.min(n - 1, Math.floor(y1 / tm));
      for (let ty = b0; ty <= b1; ty++) {
        for (let tx = a0; tx <= a1; tx++) {
          const t = this.tile(z, tx, ty);
          if (!t) continue;
          gl.bindTexture(gl.TEXTURE_2D, t);
          gl.uniform4f(uRect, tx * tm, ty * tm, tm, tm);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
      }
    }
    this.evict();
    for (const [name, alpha] of this.overlays) {
      const t = this.overlay(name);
      if (!t) continue;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1f(uAlpha, alpha);
      gl.uniform4f(uRect, 0, 0, MAP_M, MAP_M);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    if (this.grid) {
      gl.useProgram(this.lineProg);
      gl.uniform4fv(gl.getUniformLocation(this.lineProg, 'u_view'), view);
      gl.uniform4f(gl.getUniformLocation(this.lineProg, 'u_color'), 0.24, 0.24, 0.24, 0.24);
      gl.bindVertexArray(this.lineVao);
      gl.drawArrays(gl.LINES, 0, this.lineCount);
    }
    const k = this.iconScale(), d = this.dpr, m = this.markers;
    if (m.begin2d(view)) {
      for (const L of this.order) if (this.layers.has(L.id) && !L.hidden) m.layer(L.id, L.size * k * d);
      if (this.pin) m.single(this.pin.x, this.pin.y, 0, this.data.icons.pin, 30 * d);
      if (this.selected) {
        const L = this.all.find((l) => l.id === this.selected!.layer);
        const p = L?.points[this.selected.index];
        if (L && p) m.single(p.x, p.y, p.z, p.icon ?? L.icon, Math.max(30, L.size * 1.45) * k * d);
      }
      m.end();
    }
    gl.bindVertexArray(null);
  }
}
