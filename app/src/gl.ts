import { blob, fromB64, shared } from './data';

const programs = new WeakMap<WebGL2RenderingContext, Map<string, WebGLProgram>>();
const textures = new WeakMap<WebGL2RenderingContext, Map<string, Promise<WebGLTexture>>>();

export function resetGL(gl: WebGL2RenderingContext) {
  programs.delete(gl);
  textures.delete(gl);
}

export function sharedTexture(gl: WebGL2RenderingContext, key: string, make: () => Promise<WebGLTexture>): Promise<WebGLTexture> {
  let m = textures.get(gl);
  if (!m) textures.set(gl, (m = new Map()));
  let p = m.get(key);
  if (!p) {
    p = make();
    m.set(key, p);
    p.catch(() => m.delete(key));
  }
  return p;
}

export function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  let cache = programs.get(gl);
  if (!cache) programs.set(gl, (cache = new Map()));
  const key = `${vs}\n//fs\n${fs}`, hit = cache.get(key);
  if (hit) return hit;
  const make = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, make(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
  cache.set(key, p);
  return p;
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => ok(img);
    img.onerror = fail;
    img.src = url;
  });
}

export function texture(gl: WebGL2RenderingContext, img: TexImageSource, mip = true): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  if (mip) {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  }
  return t;
}

export interface TileSource {
  tile(z: number, x: number, y: number): Promise<ImageBitmap>;
  files(levels: number): string[];
}

export function fileTiles(ext: string): TileSource {
  const url = (z: number, x: number, y: number) => `./tiles/${z}/${x}_${y}.${ext}`;
  return {
    tile: (z, x, y) => blob(url(z, x, y)).then((b) => createImageBitmap(b)),
    files: (levels) => Array.from({ length: levels }, (_, z) => Array.from({ length: 4 ** z }, (_, i) => url(z, i % 2 ** z, Math.floor(i / 2 ** z)))).flat(),
  };
}

export function bundleTiles(prefix: string): TileSource {
  const key = (z: number, x: number, y: number) => (z === 3 ? `${prefix}_3_${(y >> 2) * 2 + (x >> 2)}` : `${prefix}_${z}`);
  return {
    tile: (z, x, y) => shared<Record<string, string>>(`./${key(z, x, y)}.json`)
      .then((b) => createImageBitmap(new Blob([fromB64(b[`${x}_${y}`])], { type: 'image/webp' }))),
    files: (levels) => Array.from({ length: Math.min(levels, 3) }, (_, z) => `./${prefix}_${z}.json`),
  };
}
