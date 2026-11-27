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

  static async compose(url: string, grid: number[], off: number[], tiles: number): Promise<Terrain> {
    const t = await library(url), raw = t.raw;
    const m = t.n - 1, n = tiles * m + 1, h = new Float32Array(n * n), per = t.n * t.n;
    const at = (p: number, r: number, c: number) => (raw[p * per + r * t.n + c] - 32768) / 128;
    for (const raised of [false, true]) for (let ty = 0; ty < tiles; ty++) for (let tx = 0; tx < tiles; tx++) {
      const k = ty * tiles + tx;
      if (off[k] > 0 !== raised) continue;
      for (let r = 0; r < t.n; r++) for (let c = 0; c < t.n; c++) h[(ty * m + r) * n + tx * m + c] = at(grid[k], r, c) + off[k];
    }
    Terrain.shieldRamp(h, n, m, tiles, off, t.step, at, Array.from({ length: 16 }, (_, i) => t.names.indexOf(`SoS_Arrakis_DunesLow04_x${i % 4}_y${i >> 2}`)));
    return new Terrain(h, n, t.step);
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
