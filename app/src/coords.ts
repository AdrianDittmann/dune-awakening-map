import { binary, fromB64, json } from './data';

export interface Geo { size: number; n: number; letters: string; lettersAreRows: boolean }

export const HAGGA: Geo = { size: 8128, n: 8, letters: 'ABCDEFGH', lettersAreRows: false };
export const DEEP: Geo = { size: 24384, n: 9, letters: 'ABCDEFGHI', lettersAreRows: true };
export const OVERLAND: Geo = { size: 3000, n: 1, letters: 'A', lettersAreRows: false };

const RAMP_M = 500;

export let MAP_M = HAGGA.size;
export let SECTOR_M = HAGGA.size / HAGGA.n;
let G = HAGGA;

export function setGeo(g: Geo) { G = g; MAP_M = g.size; SECTOR_M = g.size / g.n; }

export function sectorName(col: number, row: number): string {
  return G.lettersAreRows ? `${G.letters[G.n - 1 - row]}${col + 1}` : `${G.letters[col]}${row + 1}`;
}

export function gridRef(x: number, y: number): string {
  const cx = Math.min(Math.max(Math.floor(x / SECTOR_M), 0), G.n - 1);
  const cy = Math.min(Math.max(Math.floor(y / SECTOR_M), 0), G.n - 1);
  const sx = Math.min(99, Math.floor(((x - cx * SECTOR_M) / SECTOR_M) * 100));
  const sy = Math.min(99, Math.floor(((y - cy * SECTOR_M) / SECTOR_M) * 100));
  return `${sectorName(cx, cy)} ${String(sx).padStart(2, '0')} ${String(sy).padStart(2, '0')}`;
}

export function parseGrid(q: string): [number, number] | null {
  const L = G.letters, last = L[L.length - 1];
  const m = q.trim().toUpperCase().match(new RegExp(`^([A-${last}])\\s*-?\\s*([1-${G.n}])(?:[\\s,.-]*(\\d{2})[\\s,.-]*(\\d{2}))?$`));
  if (!m) return null;
  const sx = m[3] ? +m[3] + 0.5 : 50, sy = m[4] ? +m[4] + 0.5 : 50;
  const a = L.indexOf(m[1]), b = +m[2] - 1;
  const col = G.lettersAreRows ? b : a, row = G.lettersAreRows ? G.n - 1 - a : b;
  return [(col + sx / 100) * SECTOR_M, (row + sy / 100) * SECTOR_M];
}

interface Patch { x0: number; y0: number; nx: number; ny: number; o: number; b: number }
interface Land { step: number; fixed: Patch | null; sets: Record<string, Patch>; raw: Uint16Array }
const lands = new Map<string, Promise<Land>>();

function land(url: string): Promise<Land> {
  let p = lands.get(url);
  if (!p) {
    p = json<{ step: number; fixed: Patch | null; sets: Record<string, Patch>; b64: string }>(url).then((t) => {
      const b = fromB64(t.b64);
      return { step: t.step, fixed: t.fixed, sets: t.sets, raw: new Uint16Array(b.buffer, b.byteOffset, b.byteLength / 2) };
    });
    lands.set(url, p);
    p.catch(() => lands.delete(url));
  }
  return p;
}

interface Library { names: string[]; n: number; step: number; raw: Uint16Array }
const libraries = new Map<string, Promise<Library>>();

function library(url: string): Promise<Library> {
  let p = libraries.get(url);
  if (!p) {
    p = json<{ names: string[]; n: number; step: number; b64: string }>(url).then((t) => {
      const b = fromB64(t.b64);
      return { names: t.names, n: t.n, step: t.step, raw: new Uint16Array(b.buffer, b.byteOffset, b.byteLength / 2) };
    });
    libraries.set(url, p);
    p.catch(() => libraries.delete(url));
  }
  return p;
}

export class Terrain {
  constructor(readonly h: Float32Array, readonly n: number, readonly step: number) {}

  static async load(url: string, n: number, step: number): Promise<Terrain> {
    const bytes = await binary(url);
    const raw = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    const h = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) h[i] = raw[i] / 128 - 256;
    return new Terrain(h, n, step);
  }

  static async compose(url: string, grid: number[], off: number[], tiles: number, landUrl?: string, places?: number[][]): Promise<Terrain> {
    const [t, L] = await Promise.all([library(url), landUrl && places ? land(landUrl) : Promise.resolve(null)]), raw = t.raw;
    const m = t.n - 1, n = tiles * m + 1, h = new Float32Array(n * n), per = t.n * t.n;
    const at = (p: number, r: number, c: number) => (raw[p * per + r * t.n + c] - 32768) / 128;
    for (const raised of [false, true]) for (let ty = 0; ty < tiles; ty++) for (let tx = 0; tx < tiles; tx++) {
      const k = ty * tiles + tx;
      if (off[k] > 0 !== raised) continue;
      for (let r = 0; r < t.n; r++) for (let c = 0; c < t.n; c++) h[(ty * m + r) * n + tx * m + c] = at(grid[k], r, c) + off[k];
    }
    Terrain.shieldRamp(h, n, m, tiles, off, t.step, at, Array.from({ length: 16 }, (_, i) => t.names.indexOf(`SoS_Arrakis_DunesLow04_x${i % 4}_y${i >> 2}`)));
    if (L && places) {
      if (L.fixed) Terrain.patch(h, n, t.step, L, L.fixed, 0, 0, 0, 0);
      for (const [s, x, y, z, yaw] of places) { const P = L.sets[s]; if (P) Terrain.patch(h, n, t.step, L, P, x, y, z, yaw); }
    }
    return new Terrain(h, n, t.step);
  }

  private static patch(h: Float32Array, n: number, step: number, L: Land, P: Patch, X: number, Y: number, Z: number, yaw: number) {
    const a = (yaw * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), u = L.raw, ps = L.step;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const lx of [P.x0, P.x0 + (P.nx - 1) * ps]) for (const ly of [P.y0, P.y0 + (P.ny - 1) * ps]) {
      const wx = X + lx * c - ly * s, wy = Y + lx * s + ly * c;
      x0 = Math.min(x0, wx); x1 = Math.max(x1, wx); y0 = Math.min(y0, wy); y1 = Math.max(y1, wy);
    }
    const c0 = Math.max(0, Math.floor(x0 / step)), c1 = Math.min(n - 1, Math.ceil(x1 / step));
    const r0 = Math.max(0, Math.floor(y0 / step)), r1 = Math.min(n - 1, Math.ceil(y1 / step));
    for (let r = r0; r <= r1; r++) for (let col = c0; col <= c1; col++) {
      const dx = col * step - X, dy = r * step - Y;
      const fx = (dx * c + dy * s - P.x0) / ps, fy = (-dx * s + dy * c - P.y0) / ps;
      if (fx < 0 || fy < 0 || fx > P.nx - 1 || fy > P.ny - 1) continue;
      const ix = Math.min(Math.floor(fx), P.nx - 2), iy = Math.min(Math.floor(fy), P.ny - 2), tx = fx - ix, ty = fy - iy;
      const i = P.o + iy * P.nx + ix, q00 = u[i], q10 = u[i + 1], q01 = u[i + P.nx], q11 = u[i + P.nx + 1];
      if (!q00 || !q10 || !q01 || !q11) continue;
      const v = P.b + ((q00 * (1 - tx) + q10 * tx) * (1 - ty) + (q01 * (1 - tx) + q11 * tx) * ty) / 32 + Z, j = r * n + col;
      if (v > h[j]) h[j] = v;
    }
  }

  private static shieldRamp(h: Float32Array, n: number, m: number, tiles: number, off: number[], step: number, at: (p: number, r: number, c: number) => number, low: number[]) {
    const up = off.flatMap((o, k) => (o > 0 ? [k] : []));
    if (!up.length || low.some((i) => i < 0)) return;
    const L = RAMP_M / step;
    let r0 = n, r1 = 0, c0 = n, c1 = 0;
    for (const k of up) {
      const ty = Math.floor(k / tiles), tx = k % tiles;
      r0 = Math.min(r0, ty * m - L); r1 = Math.max(r1, (ty + 1) * m + L); c0 = Math.min(c0, tx * m - L); c1 = Math.max(c1, (tx + 1) * m + L);
    }
    r0 = Math.max(0, Math.floor(r0)); c0 = Math.max(0, Math.floor(c0)); r1 = Math.min(n - 1, Math.ceil(r1)); c1 = Math.min(n - 1, Math.ceil(c1));
    const W = c1 - c0 + 1, D = new Float32Array(W * (r1 - r0 + 1)).fill(Infinity), O = new Float32Array(D.length);
    for (const k of up) {
      const ty = Math.floor(k / tiles), tx = k % tiles;
      for (let r = Math.max(r0, Math.floor(ty * m - L)); r <= Math.min(r1, Math.ceil((ty + 1) * m + L)); r++) {
        const dy = Math.max(ty * m - r, r - (ty + 1) * m, 0);
        for (let c = Math.max(c0, Math.floor(tx * m - L)); c <= Math.min(c1, Math.ceil((tx + 1) * m + L)); c++) {
          const d = Math.hypot(Math.max(tx * m - c, c - (tx + 1) * m, 0), dy), i = (r - r0) * W + c - c0;
          if (d < D[i]) { D[i] = d; O[i] = off[k]; }
        }
      }
    }
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const i = (r - r0) * W + c - c0, d = D[i];
      if (!(d > 0 && d < L)) continue;
      const tx = Math.min(tiles - 1, Math.floor(c / m)), ty = Math.min(tiles - 1, Math.floor(r / m)), s = d / L, w = s * s * (3 - 2 * s), j = r * n + c;
      h[j] = (1 - w) * (at(low[(tx % 4) + 4 * (ty % 4)], r - ty * m, c - tx * m) + O[i]) + w * h[j];
    }
  }

  at(x: number, y: number): number {
    const fx = Math.min(Math.max(x / this.step, 0), this.n - 1.001);
    const fy = Math.min(Math.max(y / this.step, 0), this.n - 1.001);
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const i = iy * this.n + ix, h = this.h, n = this.n;
    const a = h[i] + (h[i + 1] - h[i]) * tx;
    const b = h[i + n] + (h[i + n + 1] - h[i + n]) * tx;
    return a + (b - a) * ty;
  }
}
