import { gridRef, parseGrid, sectorName, MAP_M, SECTOR_M } from './coords';
import type { Icons, Layer, MapData, Point, Resource } from './types';

export interface UIHooks {
  toggleLayer(id: string, on: boolean): void;
  toggleOverlay(name: string, on: boolean, alpha: number): void;
  toggleGrid(on: boolean): void;
  select(layer: string, index: number, fly: boolean): void;
  pin(x: number, y: number, fly: boolean): void;
  clear(): void;
  mode(m: '2d' | '3d'): void;
  relief(x: number): void;
  world(w: 'hagga' | 'dd' | 'om', layout?: number): void;
  goto(w: 'hagga' | 'dd' | 'om', layer: string, sub: string, region?: string): void;
}

const DEFAULT_ON = new Set(['trade', 'outpost', 'fortress', 'wreck', 'ecolab', 'crash', 'spice', 'arrive']);
const DEFAULT_ON_DD = new Set(['taxi', 'wreck', 'ecolab', 'spicem', 'arrive']);
const DEFAULT_ON_OM = new Set(['gate', 'poi', 'landing']);
const GROUP_ORDER = ['Overland', 'Locations', 'Dynamic events', 'Travel'];
const LAYER_ORDER = ['taxi', 'trade', 'outpost', 'camp', 'fortress', 'wreck', 'ecolab', 'cave', 'altar', 'control', 'house', 'quarter', 'crash', 'spice', 'spicem', 'flour', 'arrive', 'exit', 'desert', 'rock', 'orni', 'buggy', 'npc', 'contract', 'loot'];
const SINGULAR: Record<string, string> = {
  trade: 'Trading post', outpost: 'Enemy outpost', camp: 'Enemy camp', fortress: 'Fortress', wreck: 'Shipwreck', ecolab: 'Imperial Testing Station',
  cave: 'Cave', altar: 'Cave altar', control: 'Control point', house: 'House representative', quarter: 'Quartermaster', crash: 'Crashed-ship site',
  spice: 'Small spice field', flour: 'Flour sand field', desert: 'Desert encounter slot', rock: 'Rock-island encounter slot', orni: 'Ornithopter spawn slot',
  buggy: 'Buggy spawn slot', npc: 'NPC spawn point', contract: 'Contract target', loot: 'Loot spawner',
  taxi: 'Taxi service', spicem: 'Medium spice field', arrive: 'Overmap arrival', exit: 'Exit to the overmap',
  gate: 'Entry gate', landing: 'Exit landing', poi: 'Overland place',
};
const GOAL = 10000;
const TRACK_KEY = 'hagga-10k';
const SWATCH: Record<string, string> = { mask_radiation: '#aac846', mask_crashzone: '#5ab4ff', mask_spicezone: '#e67828', 'dd/mask_pve': '#6ec896' };
const ZONES: Record<string, Record<string, string>> = {
  hagga: { mask_radiation: 'Radiation zone', mask_crashzone: 'Crash spawn area', mask_spicezone: 'Spice spawn area' },
  dd: { 'dd/mask_pve': 'Safe zone on the PvP map' },
};
const pct = (c: number) => `${Math.max(1, Math.round(c * 100))}%`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const fmt = (n: number) => n.toLocaleString('en-US');

export const resLabel = (r: Resource) => r.game ?? r.name;

export function initialLayers(w?: string): Set<string> { return new Set(w === 'dd' ? DEFAULT_ON_DD : w === 'om' ? DEFAULT_ON_OM : DEFAULT_ON); }

interface Track { counts: Record<string, number>; done: Record<string, boolean>; hist: { id: string; d: number; flip?: boolean }[] }

function loadTrack(): Track {
  try {
    const v = JSON.parse(localStorage.getItem(TRACK_KEY) ?? '{}');
    if (v && v.v === 2) return { counts: v.counts ?? {}, done: v.done ?? {}, hist: v.hist ?? [] };
    return { counts: (v ?? {}) as Record<string, number>, done: {}, hist: [] };
  } catch { return { counts: {}, done: {}, hist: [] }; }
}

export class UI {
  private card: HTMLElement;
  private readout: HTMLElement;
  private results: HTMLElement;
  private input: HTMLInputElement;
  private tipEl: HTMLElement;
  private labels: HTMLElement[] = [];
  private mapLabels: HTMLElement[] = [];
  private atlas: string;
  private track = loadTrack();

  constructor(private root: HTMLElement, private data: MapData, private hooks: UIHooks) {
    this.atlas = new URL(data.icons.file, document.baseURI).href;
    const byGroup = new Map<string, Layer[]>();
    for (const L of data.layers) {
      if (!L.points.length) continue;
      if (!byGroup.has(L.group)) byGroup.set(L.group, []);
      byGroup.get(L.group)!.push(L);
    }
    for (const ls of byGroup.values()) ls.sort((a, b) => LAYER_ORDER.indexOf(a.id) - LAYER_ORDER.indexOf(b.id));
    const section = (title: string, body: string) => `<section><h2>${title}</h2>${body}</section>`;
    const dd = data.world === 'dd', om = data.world === 'om', on = initialLayers(data.world);
    const layerRows = (ls: Layer[]) => ls.map((L) => this.row(`data-layer="${L.id}"`, this.icon(L.icon), L.name, String(L.points.length), on.has(L.id))).join('');
    const w0 = data.world ?? 'hagga';
    const worlds = `<div class="worlds">${[['hagga', 'Hagga Basin'], ['dd', 'Deep Desert'], ['om', 'Overland']].map(([k, nm]) => `<button data-world="${k}"${k === w0 ? ' class="on"' : ''}>${nm}</button>`).join('')}</div>`;
    const layouts = dd && data.layouts ? `<div class="kicker sub">Weekly layout</div><div class="layouts">${data.layouts.map((n) => `<button data-layout="${n}" class="${n === data.layout ? 'on' : ''}${n === data.live ? ' live' : ''}"${n === data.live ? ' title="Live in your game this week"' : ''}>${n + 1}</button>`).join('')}</div>` : '';
    let html = `<div class="gridlabels"></div><div class="maplabels"></div><aside class="panel"><header><div class="kicker">Dune: Awakening</div>${worlds}${layouts}</header>
      <div class="search"><input type="search" placeholder="${dd ? 'Search, or sectors to find the layout' : om ? 'Search places' : 'Search places, resources or grid'}" spellcheck="false" autocomplete="off"></div><div class="results"></div><div class="scroll">`;
    for (const g of GROUP_ORDER) if (byGroup.has(g)) html += section(g, layerRows(byGroup.get(g)!));
    if (data.resources.length) html += section('Resources', data.resources.map((r) => this.row(`data-res="${r.id}"`, this.icon(r.icon), resLabel(r), '', false)).join(''));
    html += `<section class="tracker"><h2><span>10,000 of each</span><span class="tools"><button class="undo" hidden>Undo</button><span class="done"></span></span></h2>${data.tracker.map((t) =>
      `<div class="trow" data-id="${t.id}">${this.icon(t.icon)}<span class="name">${esc(t.name)}</span><input class="amt" inputmode="numeric" enterkeyhint="done" aria-label="Add ${esc(t.name)}"><button class="tick" aria-label="${esc(t.name)} done" aria-pressed="false"></button><span class="bar"><i></i></span></div>`).join('')}</section>`;
    if (!om) html += section('Zones', [
      this.row('data-grid="1"', '<span class="swatch grid"></span>', 'Grid', '', true),
      ...Object.entries(ZONES[dd ? 'dd' : 'hagga'])
        .map(([id, name]) => this.row(`data-overlay="${id}"`, `<span class="swatch" style="--c:${SWATCH[id]}"></span>`, name, '', false)),
    ].join(''));
    const adv = [...byGroup.entries()].filter(([g]) => !GROUP_ORDER.includes(g)).map(([g, ls]) => section(g, layerRows(ls))).join('');
    html += `<details class="advanced"><summary>Advanced</summary>${adv}</details></div></aside>
      <div class="mode"${om ? ' hidden' : ''}><div class="seg"><button data-mode="2d" class="on">2D</button><button data-mode="3d">3D</button></div>
      <div class="seg relief" hidden><button data-relief="1" class="on">1×</button><button data-relief="1.5">1.5×</button><button data-relief="3">3×</button></div></div>
      <div class="card" hidden></div><div class="readout"></div><div class="tip" hidden></div>`;
    root.innerHTML = html;
    this.card = root.querySelector('.card')!;
    this.readout = root.querySelector('.readout')!;
    this.results = root.querySelector('.results')!;
    this.input = root.querySelector<HTMLInputElement>('.search input')!;
    this.tipEl = root.querySelector('.tip')!;
    const panel = root.querySelector<HTMLElement>('.panel')!;
    panel.addEventListener('scroll', () => { if (panel.scrollTop) panel.scrollTop = 0; });
    this.initTracker();
    const gl = root.querySelector('.gridlabels')!;
    const n = om ? 0 : Math.round(MAP_M / SECTOR_M);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const el = document.createElement('span');
      el.textContent = sectorName(c, r);
      gl.appendChild(el);
      this.labels.push(el);
    }
    root.querySelectorAll<HTMLButtonElement>('[data-world]').forEach((b) => b.addEventListener('click', () => {
      if (!b.classList.contains('on')) hooks.world(b.dataset.world as 'hagga' | 'dd' | 'om');
    }));
    root.querySelectorAll<HTMLButtonElement>('[data-layout]').forEach((b) => b.addEventListener('click', () => {
      if (!b.classList.contains('on')) hooks.world('dd', +b.dataset.layout!);
    }));
    root.querySelectorAll<HTMLInputElement>('input[data-layer]').forEach((el) => el.addEventListener('change', () => hooks.toggleLayer(el.dataset.layer!, el.checked)));
    root.querySelectorAll<HTMLInputElement>('input[data-res]').forEach((el) => el.addEventListener('change', () => this.setResource(el.dataset.res!, el.checked)));
    root.querySelectorAll<HTMLInputElement>('input[data-overlay]').forEach((el) => el.addEventListener('change', () => hooks.toggleOverlay(el.dataset.overlay!, el.checked, 0.75)));
    root.querySelector<HTMLInputElement>('input[data-grid]')?.addEventListener('change', (e) => hooks.toggleGrid((e.target as HTMLInputElement).checked));
    const ml = root.querySelector('.maplabels')!;
    for (const l of data.labels ?? []) {
      const el = document.createElement('span');
      el.textContent = l.text;
      if (l.big) el.className = 'big';
      ml.appendChild(el);
      this.mapLabels.push(el);
    }
    root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      root.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
      (root.querySelector('.relief') as HTMLElement).hidden = b.dataset.mode !== '3d';
      hooks.mode(b.dataset.mode as '2d' | '3d');
    }));
    root.querySelectorAll<HTMLButtonElement>('[data-relief]').forEach((b) => b.addEventListener('click', () => {
      root.querySelectorAll('[data-relief]').forEach((x) => x.classList.toggle('on', x === b));
      hooks.relief(parseFloat(b.dataset.relief!));
    }));
    this.input.addEventListener('input', () => this.search(this.input.value));
    this.results.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('button');
      if (!t) return;
      this.act(t.dataset);
      this.input.value = '';
      this.search('');
    });
    this.card.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('button');
      if (!t) return;
      if (t.classList.contains('x')) this.hooks.clear();
      else this.act(t.dataset);
    });
  }

  private initTracker() {
    const T = this.track, names = new Map(this.data.tracker.map((t) => [t.id, t.name]));
    const rows = [...this.root.querySelectorAll<HTMLElement>('.trow')];
    const done = this.root.querySelector<HTMLElement>('.tracker .done')!;
    const undo = this.root.querySelector<HTMLButtonElement>('.tracker .undo')!;
    const save = () => { try { localStorage.setItem(TRACK_KEY, JSON.stringify({ v: 2, counts: T.counts, done: T.done, hist: T.hist.slice(-50) })); } catch { /* storage blocked */ } };
    const paint = () => {
      let n = 0;
      for (const row of rows) {
        const id = row.dataset.id!, v = T.counts[id] ?? 0, full = !!T.done[id] || v >= GOAL;
        const input = row.querySelector<HTMLInputElement>('.amt')!, editing = document.activeElement === input;
        if (!editing) input.value = v ? fmt(v) : '';
        input.placeholder = editing ? '+' : '0';
        row.querySelector<HTMLElement>('.bar i')!.style.width = `${full ? 100 : Math.min(100, (v / GOAL) * 100)}%`;
        row.classList.toggle('full', full);
        row.querySelector('.tick')!.setAttribute('aria-pressed', String(!!T.done[id]));
        if (full) n++;
      }
      done.textContent = `${n} / ${rows.length}`;
      const last = T.hist[T.hist.length - 1];
      undo.hidden = !last;
      undo.title = last ? `Undo ${last.flip ? 'done mark' : (last.d > 0 ? '+' : '') + fmt(last.d)}, ${names.get(last.id) ?? ''}` : '';
    };
    const add = (id: string, d: number) => {
      const was = T.counts[id] ?? 0, now = Math.min(999999, Math.max(0, was + d));
      if (now === was) return;
      T.counts[id] = now; T.hist.push({ id, d: now - was }); save(); paint();
    };
    undo.addEventListener('click', () => {
      const h = T.hist.pop();
      if (!h) return;
      if (h.flip) T.done[h.id] = !T.done[h.id];
      else T.counts[h.id] = Math.max(0, (T.counts[h.id] ?? 0) - h.d);
      save(); paint();
    });
    for (const row of rows) {
      const input = row.querySelector<HTMLInputElement>('.amt')!, id = row.dataset.id!;
      const commit = () => {
        const s = input.value.trim();
        input.value = '';
        if (!s) return;
        const n = parseInt(s.replace(/[^0-9-]/g, ''), 10);
        if (Number.isNaN(n)) return;
        add(id, s.startsWith('=') ? n - (T.counts[id] ?? 0) : n);
      };
      input.addEventListener('focus', () => { input.value = ''; paint(); });
      input.addEventListener('blur', () => { commit(); paint(); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.value = ''; input.blur(); }
      });
      row.querySelector('.tick')!.addEventListener('click', () => {
        T.done[id] = !T.done[id]; T.hist.push({ id, d: 0, flip: true }); save(); paint();
      });
    }
    paint();
  }

  icon(i: number, px = 18) {
    const { cols, rows }: Icons = this.data.icons;
    return `<span class="ico" style="background-image:url('${this.atlas}');background-size:${cols * px}px ${rows * px}px;background-position:-${(i % cols) * px}px -${Math.floor(i / cols) * px}px"></span>`;
  }

  private row(attr: string, icon: string, name: string, count: string, on: boolean) {
    return `<label class="row"><input type="checkbox" ${attr} ${on ? 'checked' : ''}>${icon}<span class="name">${esc(name)}</span><span class="count">${count}</span></label>`;
  }

  setResource(id: string, on: boolean) {
    const box = this.root.querySelector<HTMLInputElement>(`input[data-res="${id}"]`);
    if (box) box.checked = on;
    const r = this.data.resources.find((x) => x.id === id);
    this.hooks.toggleOverlay(r?.overlay ?? `res/${id}`, on, 0.55);
    for (const l of [`res:${id}`, `nodes:${id}:f`, `nodes:${id}:s`]) this.hooks.toggleLayer(l, on);
  }

  setLayer(id: string, on: boolean) {
    const m = id.match(/^(?:res|nodes):([a-z]+)/);
    if (m) { this.setResource(m[1], on); return; }
    const box = this.root.querySelector<HTMLInputElement>(`input[data-layer="${id}"]`);
    if (box) box.checked = on;
    this.hooks.toggleLayer(id, on);
  }

  private act(d: DOMStringMap) {
    if (d.hit) { const [layer, idx] = d.hit.split('|'); this.hooks.select(layer, +idx, true); }
    else if (d.res) { this.setResource(d.res, true); const r = this.data.resources.find((x) => x.id === d.res)!; if (r.spots.length) this.hooks.select(`res:${r.id}`, 0, true); }
    else if (d.layer) this.setLayer(d.layer, true);
    else if (d.go) { const [x, y] = d.go.split(',').map(Number); this.hooks.pin(x, y, true); }
    else if (d.layout) this.hooks.world('dd', +d.layout);
    else if (d.goto) { const [w, layer, sub, region] = d.goto.split('|'); this.hooks.goto(w as 'hagga' | 'dd' | 'om', layer, sub, region || undefined); }
  }

  private search(q: string) {
    q = q.trim().toLowerCase();
    if (q.length < 2) { this.results.innerHTML = ''; return; }
    const out: string[] = [];
    const btn = (data: string, icon: string, name: string, meta: string) =>
      `<button ${data}>${icon}<span class="name">${esc(name)}</span><span class="count">${esc(meta)}</span></button>`;
    const g = parseGrid(q);
    if (g) out.push(btn(`data-go="${g[0]},${g[1]}"`, this.icon(this.data.icons.pin), gridRef(g[0], g[1]), 'Grid'));
    const em = q.match(/^e?\s*(\d{1,5})\s*(?:m)?\s*[,·\s]\s*s?\s*(\d{1,5})\s*(?:m)?$/i);
    if (em && +em[1] <= MAP_M && +em[2] <= MAP_M) out.push(btn(`data-go="${+em[1]},${+em[2]}"`, this.icon(this.data.icons.pin), `E ${em[1]} · S ${em[2]}`, gridRef(+em[1], +em[2])));
    const idx = this.data.index, toks = q.toUpperCase().match(/[A-I][1-9]/g);
    if (idx && toks && !q.replace(/[a-i][1-9]|[\s,;]+/gi, '')) {
      const want = [...new Set(toks)], kinds = ['ecolab', 'wreck', 'cave'];
      const name: Record<string, string> = { ecolab: 'testing station', wreck: 'wreck', cave: 'cave' };
      for (const [n, t] of Object.entries(idx)) {
        const why = want.map((sct) => { const k = kinds.find((x) => t[x]?.includes(sct)); return k ? `${name[k]} ${sct}` : ''; });
        if (why.every(Boolean)) {
          const L = this.data.layers.find((l) => l.id === kinds.find((x) => why[0].startsWith(name[x])));
          out.push(btn(`data-layout="${n}"`, this.icon(L?.icon ?? this.data.icons.pin), `Layout ${+n + 1} · ${why.join(', ')}`, ''));
        }
      }
    }
    for (const r of this.data.resources) {
      const hay = [r.name, r.game ?? '', ...r.aliases].join(' ').toLowerCase();
      if (!hay.includes(q)) continue;
      const n = r.nodes[0] + r.nodes[1];
      out.push(btn(`data-res="${r.id}"`, this.icon(r.icon), resLabel(r), n ? `${fmt(n)} spots` : 'Resource'));
      r.spots.forEach((s, i) => out.push(btn(`data-hit="res:${r.id}|${i}"`, this.icon(r.icon), s.near ? `Near ${s.near}` : gridRef(s.x, s.y), s.n ? `about ${Math.max(1, Math.round(s.n))} nodes` : s.region ?? gridRef(s.x, s.y))));
    }
    for (const L of this.data.layers) if (L.points.length && L.name.toLowerCase().includes(q)) out.push(btn(`data-layer="${L.id}"`, this.icon(L.icon), L.name, `${L.points.length}`));
    for (const L of this.data.layers) {
      if (L.group !== 'Locations' && L.group !== 'Overland') continue;
      L.points.forEach((p, i) => {
        const hay = `${p.name ?? ''} ${p.region ?? ''} ${p.faction ?? ''} ${p.sub ?? ''}`.toLowerCase();
        if (hay.includes(q)) out.push(btn(`data-hit="${L.id}|${i}"`, this.icon(p.icon ?? L.icon), p.name ?? L.name, p.region ?? L.name));
      });
    }
    this.results.innerHTML = out.slice(0, 12).join('');
  }

  private resOf(L: Layer) {
    const m = L.id.match(/^(?:res|nodes):([a-z]+)/);
    return m ? this.data.resources.find((r) => r.id === m[1]) : undefined;
  }

  label(L: Layer, p: Point): [string, string] {
    const res = this.resOf(L);
    if (res) {
      const kind = L.id.startsWith('res:') ? (p.n ? 'Best area' : 'Resource zone') : L.id.endsWith(':f') ? 'Fixed spot' : p.c !== undefined ? `Shared spot · ${pct(p.c)}` : 'Shared spot';
      return [resLabel(res), [kind, p.region].filter(Boolean).join(' · ')];
    }
    const type = SINGULAR[L.id] ?? L.name;
    return p.name ? [p.name, [type, p.region].filter(Boolean).join(' · ')] : [type, gridRef(p.x, p.y)];
  }

  show(L: Layer, p: Point) {
    const res = this.resOf(L), om = this.data.world === 'om';
    const [title, meta] = this.label(L, p);
    const lines = om ? [] : this.coords(p.x, p.y, p.z, p.g);
    const region = this.data.world === 'dd' ? 'DeepDesert1' : 'Survival1', rname = (r?: string) => (r === 'DeepDesert1' ? 'Deep Desert' : 'Hagga Basin');
    const link = (goto: string, text: string) => `<button class="link" data-goto="${goto}">${esc(text)}</button>`;
    if (L.id === 'gate' && p.to) lines.push(`<dt>Arrive</dt><dd>${link(`${p.to === 'DeepDesert1' ? 'dd' : 'hagga'}|arrive|${p.sub}`, `${rname(p.to)} · ${p.dest ?? ''}`)}</dd>`);
    if (L.id === 'gate' && p.pvp) lines.push('<dt>Mode</dt><dd>Pick the PvE or PvP map at the gate</dd>');
    if (L.id === 'landing' && p.from) lines.push(`<dt>From</dt><dd>${link(`${p.from === 'DeepDesert1' ? 'dd' : 'hagga'}|exit|${p.sub}`, `${rname(p.from)} edge, gate ${p.sub}`)}</dd>`);
    if (!om && L.id === 'arrive') lines.push(`<dt>Overland</dt><dd>${link(`om|gate|${p.sub}|${region}`, `Gate ${p.sub} on the overland map`)}</dd>`);
    if (!om && L.id === 'exit') lines.push(`<dt>Lands at</dt><dd>${link(`om|landing|${p.sub}|${region}`, `Overland, ${p.sub} side`)}</dd>`);
    if (res && L.id.startsWith('nodes:')) {
      if (!L.id.endsWith(':f') && p.c !== undefined) lines.push(`<dt>Chance</dt><dd>${pct(p.c)}</dd>`);
      lines.push(`<dt>Spawns</dt><dd>${L.id.endsWith(':f') ? `Always ${esc(resLabel(res))}` : 'One of several resources, chosen by the game'}</dd>`);
    }
    if (res && L.id.startsWith('res:')) {
      if (p.near) lines.push(`<dt>Near</dt><dd>${esc(p.near)}</dd>`);
      if (p.area_km2) lines.push(`<dt>Size</dt><dd>${p.area_km2} km²</dd>`);
      if (p.n) lines.push(`<dt>Nodes</dt><dd>about ${Math.max(1, Math.round(p.n))} here at a time</dd>`);
      if (res.spots.length > 1) lines.push(`<dt>Others</dt><dd>${res.spots.map((s, i) => s === p ? '' : `<button class="link" data-hit="${L.id}|${i}">${esc(s.near ?? gridRef(s.x, s.y))}</button>`).filter(Boolean).join('')}</dd>`);
    }
    const r = L.rule;
    if (r) {
      const parts: string[] = [];
      if (r.max) parts.push(`up to ${r.max} at once`);
      if (r.every) parts.push(`one new every ${r.every} min`);
      if (r.life) parts.push(`${r.every ? 'switches off after' : 'lasts'} ${r.life} min${r.every ? ' untouched' : ''}`);
      if (r.cd) parts.push(`${r.cd} min between spawns`);
      if (r.near === false) parts.push('spawns with nobody near');
      lines.push(`<dt>Spawns</dt><dd>${parts.join(' · ')}</dd>`);
    }
    this.open(this.icon(p.icon ?? L.icon, 22), title, meta, lines);
  }

  showPin(x: number, y: number, h: number) {
    this.open(this.icon(this.data.icons.pin, 22), gridRef(x, y), 'Pinned spot', this.coords(x, y, h, h));
  }

  tip(t: { L: Layer; p: Point; x: number; y: number; r: number } | null) {
    if (!t) { this.tipEl.hidden = true; return; }
    const [title, meta] = this.label(t.L, t.p);
    this.tipEl.innerHTML = `${this.icon(t.p.icon ?? t.L.icon, 20)}<span class="txt"><b>${esc(title)}</b><span>${esc(meta)}</span></span>`;
    this.tipEl.hidden = false;
    const w = this.tipEl.offsetWidth, h = this.tipEl.offsetHeight;
    const x = Math.min(Math.max(t.x - w / 2, 8), window.innerWidth - w - 8);
    const above = t.y - t.r - 6 - h;
    const y = above < 8 ? t.y + t.r + 6 : above;
    this.tipEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  private coords(x: number, y: number, z: number, g: number) {
    const lines = [`<dt>Grid</dt><dd>${gridRef(x, y)}</dd>`, `<dt>Position</dt><dd>E ${Math.round(x)} m · S ${Math.round(y)} m</dd>`];
    lines.push(`<dt>Elevation</dt><dd>${Math.round(z)} m${Math.abs(z - g) > 3 ? ` · ground ${Math.round(g)} m` : ''}</dd>`);
    return lines;
  }

  private open(icon: string, title: string, meta: string, lines: string[]) {
    this.card.innerHTML = `<button class="x" aria-label="Close">×</button><h3>${icon}<span>${esc(title)}</span></h3><div class="meta">${esc(meta)}</div><dl>${lines.join('')}</dl>`;
    this.card.hidden = false;
  }

  hide() { this.card.hidden = true; }

  cursor(x: number, y: number, h: number | null) {
    if (x < 0 || y < 0 || x > MAP_M || y > MAP_M) { this.readout.textContent = ''; return; }
    this.readout.textContent = `${gridRef(x, y)}   E ${Math.round(x)} · S ${Math.round(y)}${h === null ? '' : `   ${Math.round(h)} m`}`;
  }

  placeLabels(toScreen: (x: number, y: number) => [number, number], on: boolean) {
    const L = this.data.labels ?? [];
    this.mapLabels.forEach((el, i) => {
      el.hidden = !on;
      if (on) { const [sx, sy] = toScreen(L[i].x, L[i].y); el.style.transform = `translate(${Math.round(sx)}px, ${Math.round(sy)}px) translate(-50%, -50%)`; }
    });
  }

  placeGrid(toScreen: (x: number, y: number) => [number, number], on: boolean) {
    this.labels.forEach((el, i) => {
      const n = Math.round(MAP_M / SECTOR_M), [sx, sy] = toScreen((i % n) * SECTOR_M, Math.floor(i / n) * SECTOR_M);
      el.hidden = !on;
      if (on) el.style.transform = `translate(${Math.round(sx + 6)}px, ${Math.round(sy + 5)}px)`;
    });
  }
}
