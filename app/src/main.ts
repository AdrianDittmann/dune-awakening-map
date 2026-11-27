import './style.css';
import { Map2D } from './map2d';
import { View3D } from './view3d';
import { Terrain, MAP_M, setGeo, HAGGA, DEEP, OVERLAND } from './coords';
import { Markers } from './markers';
import { UI, initialLayers, resLabel } from './ui';
import { fileTiles, bundleTiles, resetGL, type TileSource } from './gl';
import { json, shared, fromB64, prefetch, LOCAL } from './data';
import type { Layer, MapData, Point } from './types';

interface NodeFile { scale: number; res: Record<string, { b64_fixed: string; b64_shared: string; b64_chance?: string }> }
type World = 'hagga' | 'dd' | 'om';
interface WorldId { w: World; layout: number; t?: number }
type After = (m: Mounted) => void;
interface Mounted { destroy: () => void; selectBy: (layer: string, pred: (p: Point) => boolean) => void }
interface Loaded { id: WorldId; data: MapData; terrain: Terrain; all: Layer[]; src: TileSource }
interface Seed { z: number; x: number; y: number; img: ImageBitmap }

const KEY = 'hagga-world';
let LIVE = { layout: 4, since: Date.parse('2026-11-24T00:00:00Z') };
const LIVE_URL = 'https://raw.githubusercontent.com/AdrianDittmann/dune-awakening-map/main/live.json';
const WEEK = 7 * 864e5;
const MIN_CHANCE = 0.01;
const KEEP_WORLDS = 4;
const PRELOAD_MS = 700;

function saved(): WorldId {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as WorldId | null;
    if (v && (v.w === 'hagga' || v.w === 'dd' || v.w === 'om')) return { w: v.w, layout: Number.isInteger(v.layout) && (v.t ?? 0) >= LIVE.since ? v.layout : LIVE.layout, t: v.t };
  } catch { /* storage blocked */ }
  return { w: 'hagga', layout: LIVE.layout };
}

function remember(id: WorldId) { try { localStorage.setItem(KEY, JSON.stringify(id)); } catch { /* storage blocked */ } }

const u16 = (b64: string) => { const b = fromB64(b64); return new Uint16Array(b.buffer, b.byteOffset, b.byteLength / 2); };
const n2 = (layout: number) => String(layout).padStart(2, '0');

function resourceLayers(data: MapData, nodes: Map<string, [Point[], Point[]]>): Layer[] {
  for (const r of data.resources) r.nodes ??= [0, 0];
  const zones: Layer[] = data.resources.map((r) => ({ id: `res:${r.id}`, name: resLabel(r), group: 'Resources', rule: null, icon: r.icon, size: 22, points: r.spots, hidden: true }));
  const spots: Layer[] = data.resources.filter((r) => nodes.has(r.id)).flatMap((r) => {
    const [fixed, shared] = nodes.get(r.id)!;
    r.nodes = [fixed.length, shared.length];
    return [
      { id: `nodes:${r.id}:s`, name: resLabel(r), group: 'Resources', rule: null, icon: r.icon, size: 9, points: shared },
      { id: `nodes:${r.id}:f`, name: resLabel(r), group: 'Resources', rule: null, icon: r.icon, size: 14, points: fixed },
    ];
  });
  return [...zones, ...spots];
}

async function loadHagga(id: WorldId): Promise<Loaded> {
  const data = await json<MapData>('./data/map.json');
  const [terrain, nf] = await Promise.all([
    Terrain.load(`./${data.terrain.file}`, data.terrain.shape[0], data.terrain.step_m),
    json<NodeFile>('./data/nodes.json'),
  ]);
  const nodes = new Map<string, [Point[], Point[]]>();
  for (const [rid, v] of Object.entries(nf.res)) {
    const pts = (b64: string, chance?: Uint8Array): Point[] => {
      const u = u16(b64), out: Point[] = [];
      for (let i = 0, k = 0; i < u.length; i += 2, k++) {
        const x = u[i] / nf.scale, y = u[i + 1] / nf.scale, h = terrain.at(x, y);
        out.push(chance ? { x, y, z: h, g: h, c: chance[k] / 255 } : { x, y, z: h, g: h });
      }
      return out;
    };
    nodes.set(rid, [pts(v.b64_fixed), pts(v.b64_shared, v.b64_chance ? fromB64(v.b64_chance) : undefined)]);
  }
  return { id, data, terrain, all: [...data.layers, ...resourceLayers(data, nodes)], src: fileTiles(data.tiles.ext) };
}

async function loadDeep(id: WorldId): Promise<Loaded> {
  const [data, index] = await Promise.all([
    json<MapData>(`./data/dd/layout_${n2(id.layout)}.json`),
    shared<Record<string, Record<string, string[]>>>('./data/dd/index.json'),
  ]);
  data.index = index;
  data.live = Date.now() < LIVE.since + WEEK ? LIVE.layout : undefined;
  const t = data.terrain;
  const terrain = await Terrain.compose(`./${t.file}`, t.grid!, t.off!, t.tiles!);
  const nd = data.nodes!, groups: Record<string, Uint16Array> = { Minerals: u16(nd.Minerals), Scrap: u16(nd.Scrap) };
  const nodes = new Map<string, [Point[], Point[]]>();
  for (const r of data.resources) {
    const fixed: Point[] = [], shared: Point[] = [];
    const f = nd.fixed[r.id];
    if (f) { const u = u16(f); for (let i = 0; i < u.length; i += 3) fixed.push({ x: u[i] / nd.scale, y: u[i + 1] / nd.scale, z: u[i + 2] - 1000, g: terrain.at(u[i] / nd.scale, u[i + 1] / nd.scale) }); }
    const c = nd.chance[r.id], g = r.group ? groups[r.group] : undefined;
    if (c && g) {
      const ch = fromB64(c);
      for (let k = 0, i = 0; k < ch.length; k++, i += 3) {
        if (ch[k] / 255 < MIN_CHANCE) continue;
        const x = g[i] / nd.scale, y = g[i + 1] / nd.scale;
        shared.push({ x, y, z: g[i + 2] - 1000, g: terrain.at(x, y), c: ch[k] / 255 });
      }
    }
    if (fixed.length || shared.length) nodes.set(r.id, [fixed, shared]);
  }
  for (const L of data.layers) for (const p of L.points) p.g = terrain.at(p.x, p.y);
  for (const r of data.resources) for (const p of r.spots) p.z = p.g = terrain.at(p.x, p.y);
  return { id, data, terrain, all: [...data.layers, ...resourceLayers(data, nodes)], src: bundleTiles(data.tiles.bundle!) };
}

async function loadOverland(id: WorldId): Promise<Loaded> {
  const data = await json<MapData>('./data/om/map.json');
  return { id, data, terrain: new Terrain(new Float32Array(4), 2, data.size_m), all: [...data.layers], src: bundleTiles(data.tiles.bundle!) };
}

const keyOf = (id: WorldId) => (id.w === 'dd' ? `dd:${id.layout}` : id.w);
const worlds = new Map<string, Promise<Loaded>>();

function world(id: WorldId): Promise<Loaded> {
  const k = keyOf(id);
  let p = worlds.get(k);
  if (p) worlds.delete(k);
  else {
    p = id.w === 'dd' ? loadDeep(id) : id.w === 'om' ? loadOverland(id) : loadHagga(id);
    p.catch(() => worlds.delete(k));
  }
  worlds.set(k, p);
  while (worlds.size > KEEP_WORLDS) worlds.delete(worlds.keys().next().value!);
  return p;
}

function firstView(id: WorldId): string[] {
  if (id.w === 'dd') return [`./data/dd/layout_${n2(id.layout)}.json`, './data/dd/index.json', './data/dd/terrain.json', ...bundleTiles(`data/dd/tiles_${n2(id.layout)}`).files(3)];
  if (id.w === 'om') return ['./data/om/map.json', ...bundleTiles('data/om/tiles_00').files(3)];
  return ['./data/map.json', './data/terrain_8m.json', './data/nodes.json', ...fileTiles('webp').files(3)];
}

async function preload(L: Loaded): Promise<Seed[]> {
  const dpr = Math.min(window.devicePixelRatio || 1, 2), { tile, levels } = L.data.tiles;
  const top = Math.min(levels - 1, Math.max(0, Math.ceil(Math.log2((Math.min(window.innerWidth, window.innerHeight) * 0.94 * dpr) / tile))));
  const seeds: Seed[] = [];
  let late = false;
  const jobs: Promise<void>[] = [];
  for (let z = 0; z <= top; z++) for (let y = 0; y < 2 ** z; y++) for (let x = 0; x < 2 ** z; x++) {
    jobs.push(L.src.tile(z, x, y).then((img) => { if (late) img.close(); else seeds.push({ z, x, y, img }); }, () => undefined));
  }
  await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, PRELOAD_MS))]);
  late = true;
  return seeds;
}

function mount(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement, L: Loaded, seeds: Seed[], switchTo: (id: WorldId, after?: After) => void): Mounted {
  const { data, terrain, all, src } = L;
  setGeo(data.world === 'dd' ? DEEP : data.world === 'om' ? { ...OVERLAND, size: data.size_m } : HAGGA);
  const ac = new AbortController(), sig = { signal: ac.signal };
  const ui0 = document.getElementById('ui')!;
  let dirty = true, alive = true;
  const redraw = () => { dirty = true; };
  const markers = new Markers(gl, data.icons, all, redraw);
  const map = new Map2D(gl, data, all, markers, src, redraw);
  const v3 = new View3D(gl, data, terrain, all, markers, src, redraw);
  for (const s of seeds) { map.seed(s.z, s.x, s.y, s.img); s.img.close(); }
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__map = { map, v3, gl, data };
  let mode: '2d' | '3d' = '2d';
  let drapeLoaded = false;
  const visible = initialLayers(data.world);
  if (data.world === 'om') map.grid = false;
  map.layers = visible;
  v3.layers = visible;

  const select = (layer: string, index: number, fly: boolean) => {
    const Lr = all.find((l) => l.id === layer)!;
    const p = Lr.points[index];
    map.selected = { layer, index };
    map.pin = null;
    v3.pin = null;
    v3.selected = { layer, index };
    if (fly) {
      map.flyTo(p.x, p.y, Math.max(map.ppm, 0.45));
      v3.focus(p.x, p.y);
    }
    if (!visible.has(layer)) ui.setLayer(layer, true);
    ui.show(Lr, p);
    redraw();
  };
  const pin = (x: number, y: number, fly: boolean) => {
    map.selected = null;
    v3.selected = null;
    map.pin = { x, y };
    v3.pin = { x, y };
    if (fly) {
      map.flyTo(x, y, Math.max(map.ppm, 0.45));
      v3.focus(x, y);
    }
    ui.showPin(x, y, terrain.at(x, y));
    redraw();
  };
  const clear = () => { map.selected = null; map.pin = null; v3.selected = null; v3.pin = null; ui.hide(); redraw(); };

  const ui = new UI(ui0, data, {
    toggleLayer: (id, on) => { on ? visible.add(id) : visible.delete(id); redraw(); },
    toggleOverlay: (name, on, alpha) => { on ? map.overlays.set(name, alpha) : map.overlays.delete(name); redraw(); },
    toggleGrid: (on) => { map.grid = on; redraw(); },
    select, pin, clear,
    mode: (m) => {
      mode = m;
      if (m === '3d') {
        if (!drapeLoaded) { v3.loadDrape(); drapeLoaded = true; }
        v3.focus(map.cx, map.cy);
      }
      redraw();
    },
    relief: (x) => { v3.ex = x; redraw(); },
    world: (w, layout) => switchTo(layout === undefined ? { w, layout: L.id.layout, t: L.id.t } : { w, layout, t: Date.now() }),
    goto: (w, layer, sub, region) => switchTo({ w, layout: L.id.layout }, (m) => m.selectBy(layer, (p) => p.sub === sub && (!region || p.to === region || p.from === region))),
  });

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth, h = window.innerHeight;
    const box = document.querySelector('.panel')?.getBoundingClientRect();
    map.inset = w > 720 && box ? Math.round(box.right) + 12 : 0;
    map.insetBottom = w > 720 || !box ? 0 : Math.round(h - box.top) + 8;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    map.resize(w, h, dpr); v3.resize(w, h, dpr);
    redraw();
  };
  window.addEventListener('resize', resize, sig);
  const ro = new ResizeObserver(resize);
  ro.observe(document.documentElement);
  resize();

  const pointers = new Map<number, { x: number; y: number }>();
  let moved = 0, pinch = 0, button = 0;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = 0; button = e.button;
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
  }, sig);
  const hover = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || pointers.size) { ui.tip(null); return; }
    const hit = mode === '2d' ? map.pick(e.clientX, e.clientY) : v3.pick(e.clientX, e.clientY);
    const Lr = hit ? all.find((l) => l.id === hit.layer) : undefined;
    canvas.style.cursor = Lr ? 'pointer' : '';
    if (!hit || !Lr) { ui.tip(null); return; }
    const [x, y, r] = (mode === '2d' ? map : v3).screenOf(Lr, hit.index);
    ui.tip({ L: Lr, p: Lr.points[hit.index], x, y, r });
  };
  canvas.addEventListener('pointerleave', () => ui.tip(null), sig);
  canvas.addEventListener('pointermove', (e) => {
    hover(e);
    const prev = pointers.get(e.pointerId);
    if (mode === '2d') {
      const [wx, wy] = map.toWorld(e.clientX, e.clientY);
      ui.cursor(wx, wy, wx >= 0 && wy >= 0 && wx <= MAP_M && wy <= MAP_M ? terrain.at(wx, wy) : null);
    }
    if (!prev) return;
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved += Math.abs(dx) + Math.abs(dy);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (pinch > 0) {
        if (mode === '2d') map.zoomAt(mx, my, d / pinch); else v3.zoom(pinch / d);
      }
      pinch = d;
      if (mode === '2d') map.pan(dx / 2, dy / 2); else v3.pan(dx / 2, dy / 2);
    } else if (mode === '2d') {
      map.pan(dx, dy);
    } else if (button === 2 || e.shiftKey) {
      v3.pan(dx, dy);
    } else {
      v3.orbit(dx, dy);
    }
    redraw();
  }, sig);
  canvas.addEventListener('pointerup', (e) => {
    if (pointers.size === 1 && moved < 6) {
      const hit = mode === '2d' ? map.pick(e.clientX, e.clientY) : v3.pick(e.clientX, e.clientY);
      if (hit) select(hit.layer, hit.index, false);
      else if (mode === '2d') {
        const [wx, wy] = map.toWorld(e.clientX, e.clientY);
        wx >= 0 && wy >= 0 && wx <= MAP_M && wy <= MAP_M ? pin(wx, wy, false) : clear();
      } else clear();
    }
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
  }, sig);
  canvas.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); pinch = 0; }, sig);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    ui.tip(null);
    const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016));
    if (mode === '2d') map.zoomAt(e.clientX, e.clientY, f); else v3.zoom(1 / f);
    redraw();
  }, { passive: false, signal: ac.signal });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') clear(); }, sig);

  const frame = () => {
    if (!alive) return;
    if (dirty && !gl.isContextLost()) {
      dirty = false;
      if (mode === '2d') { map.draw(); ui.placeGrid((x, y) => map.toScreen(x, y), map.grid); ui.placeLabels((x, y) => map.toScreen(x, y), true); }
      else { v3.draw(); ui.placeGrid((x, y) => [x, y], false); ui.placeLabels((x, y) => [x, y], false); }
    }
    requestAnimationFrame(frame);
  };
  frame();
  return {
    selectBy: (layer, pred) => {
      const Lr = all.find((l) => l.id === layer);
      const i = Lr ? Lr.points.findIndex(pred) : -1;
      if (Lr && i >= 0) select(layer, i, true);
    },
    destroy: () => {
      alive = false;
      ac.abort();
      ro.disconnect();
      if (!gl.isContextLost()) { map.dispose(); v3.dispose(); markers.dispose(); }
    },
  };
}

function keepAlive() {
  const ping = () => fetch('./__alive', { cache: 'no-store' }).then((r) => r.status === 204, () => false);
  ping().then((ok) => { if (ok) setInterval(ping, 20000); });
}

async function refreshLive() {
  try {
    const r = await fetch(LIVE_URL, { cache: 'no-store', signal: AbortSignal.timeout(2000) });
    const j = await r.json() as { layout: number; since: string };
    const since = Date.parse(j.since);
    if (Number.isInteger(j.layout) && j.layout >= 0 && j.layout < 12 && since > LIVE.since) LIVE = { layout: j.layout, since };
  } catch { /* offline */ }
}

async function boot() {
  if (LOCAL) { keepAlive(); await refreshLive(); }
  const [canvas, ...extra] = [...document.querySelectorAll<HTMLCanvasElement>('canvas.gl')];
  for (const c of extra) c.remove();
  const gl = canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: true, alpha: false })!;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  let current: Mounted | null = null, shown: Loaded | null = null, queued: { id: WorldId; after?: After } | null = null, running = false, warmed = false;
  const switchTo = async (id: WorldId, after?: After) => {
    queued = { id, after };
    if (running) return;
    running = true;
    const slow = setTimeout(() => document.body.classList.add('busy'), 150);
    while (queued) {
      const req: { id: WorldId; after?: After } = queued;
      queued = null;
      try {
        const L = { ...(await world(req.id)), id: req.id };
        const seeds = await preload(L);
        if (queued) { for (const s of seeds) s.img.close(); continue; }
        current?.destroy();
        current = mount(gl, canvas, L, seeds, switchTo);
        shown = L;
        remember(req.id);
        req.after?.(current);
      } catch (e) {
        console.error(e);
        if (!current && !queued && req.id.w !== 'hagga') queued = { id: { w: 'hagga', layout: LIVE.layout } };
      }
    }
    clearTimeout(slow);
    document.body.classList.remove('busy');
    running = false;
    if (!warmed && shown) {
      warmed = true;
      const others = (['hagga', 'dd', 'om'] as World[]).filter((w) => w !== shown!.id.w);
      setTimeout(() => prefetch(others.flatMap((w) => firstView({ w, layout: LIVE.layout }))), 2500);
    }
  };
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); current?.destroy(); current = null; });
  canvas.addEventListener('webglcontextrestored', () => {
    resetGL(gl);
    if (shown) switchTo(shown.id);
  });
  await switchTo(saved());
}

boot();
