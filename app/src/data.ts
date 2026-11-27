declare const __DATA_VERSION__: string;

const PREFIX = 'dune-map-';
const NAME = PREFIX + __DATA_VERSION__;
export const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const BUDGET = 160e6;

const nativeB64 = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;

export function fromB64(s: string): Uint8Array {
  if (nativeB64) return nativeB64.call(Uint8Array, s);
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let store: Promise<Cache | null> | undefined;

function disk(): Promise<Cache | null> {
  store ??= (async () => {
    if (LOCAL || typeof caches === 'undefined') return null;
    try {
      for (const k of await caches.keys()) if (k.startsWith(PREFIX) && k !== NAME) await caches.delete(k);
      return await caches.open(NAME);
    } catch {
      return null;
    }
  })();
  return store;
}

async function get(url: string, low = false): Promise<Response> {
  const abs = new URL(url, document.baseURI).href;
  const c = await disk();
  if (c) {
    const hit = await c.match(abs).catch(() => undefined);
    if (hit) return hit;
  }
  const r = await fetch(abs, low ? ({ priority: 'low' } as RequestInit) : undefined);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  if (c) c.put(abs, r.clone()).catch(() => undefined);
  return r;
}

interface Entry { value: Promise<unknown>; size: number; used: number }
const mem = new Map<string, Entry>();
let total = 0, tick = 0;

function memo<T>(key: string, make: () => Promise<[T, number]>): Promise<T> {
  const hit = mem.get(key);
  if (hit) { hit.used = ++tick; return hit.value as Promise<T>; }
  const e: Entry = { value: Promise.resolve(), size: 0, used: ++tick };
  e.value = make().then(([v, size]) => {
    if (mem.get(key) === e) { e.size = size; total += size; trim(); }
    return v;
  }, (err) => { mem.delete(key); throw err; });
  mem.set(key, e);
  return e.value as Promise<T>;
}

function trim() {
  if (total <= BUDGET) return;
  for (const [k, e] of [...mem].filter(([, e]) => e.size).sort((a, b) => a[1].used - b[1].used)) {
    if (total <= BUDGET) break;
    mem.delete(k);
    total -= e.size;
  }
}

const text = (url: string) => get(url).then((r) => r.text());

export const json = <T>(url: string): Promise<T> => text(url).then((t) => JSON.parse(t) as T);

export const binary = (url: string): Promise<Uint8Array> => json<{ b64: string }>(url).then((j) => fromB64(j.b64));

export const shared = <T>(url: string): Promise<T> => memo<T>(url, () => text(url).then((t) => [JSON.parse(t) as T, t.length]));

export const blob = (url: string): Promise<Blob> => memo<Blob>(url, () => get(url).then((r) => r.blob()).then((b) => [b, b.size]));

export async function prefetch(urls: string[]) {
  if (!(await disk())) return;
  for (const u of urls) {
    try { await (await get(u, true)).arrayBuffer(); } catch { /* skipped */ }
  }
}
