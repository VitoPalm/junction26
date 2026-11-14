/**
 * Additive-display ink for line drawings.
 *
 * The glasses (and the simulator, via mix-blend-mode: screen) add our light to
 * the world. Dark plates, blur and transparency cannot darken or soften what is
 * behind the lens, so the only lever is the light we emit: strokes must be
 * thick and bright at the size they are actually shown.
 *
 * Source diagrams are typically ~1000 px tall with 1-2 px lines. Shrunk to a
 * ~400 px display region their lines become sub-pixel and vanish. We dilate at
 * source resolution so the stroke survives the downscale at a target display
 * width, crop empty margins so the drawing uses the whole region, normalise
 * polarity (light lines on black), and lift antialiased edges to full white.
 */

export interface InkOptions {
  /** Target stroke width in CSS px on the display. */
  stroke?: number;
  /** Gain applied to downscaled luminance, so soft edges read as solid light. */
  gain?: number;
  /** Marks smaller than this many CSS px on the display are dropped as noise. */
  minDetail?: number;
}

const cache = new Map<string, Promise<string>>();

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load diagram ${src}`));
    img.src = src;
  });
}

/** Separable square max filter on a luminance plane. */
function dilate(src: Uint8ClampedArray, w: number, h: number, r: number): Uint8ClampedArray {
  if (r <= 0) return src;
  const tmp = new Uint8ClampedArray(src.length);
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 0;
      const a = Math.max(0, x - r), b = Math.min(w - 1, x + r);
      for (let i = a; i <= b; i++) { const v = src[row + i]; if (v > m) m = v; }
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 0;
      const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
      for (let i = a; i <= b; i++) { const v = tmp[i * w + x]; if (v > m) m = v; }
      out[y * w + x] = m;
    }
  }
  return out;
}

/**
 * Drop connected marks too small to read at the display scale (tiny rotated
 * part codes, specks). They would only render as noise bars once thickened.
 */
function removeSpecks(plane: Uint8ClampedArray, w: number, h: number, minSide: number): void {
  if (minSide <= 1) return;
  const label = new Int32Array(w * h).fill(-1);
  const stack: number[] = [];
  const members: number[] = [];
  for (let start = 0; start < plane.length; start++) {
    if (plane[start] < 90 || label[start] !== -1) continue;
    let minX = w, maxX = 0, minY = h, maxY = 0;
    members.length = 0;
    stack.push(start); label[start] = start;
    while (stack.length) {
      const i = stack.pop()!;
      members.push(i);
      const x = i % w, y = (i - x) / w;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      // 8-connected, with a 1 px gap bridge so dashed strokes stay one mark.
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (label[j] === -1 && plane[j] >= 90) { label[j] = start; stack.push(j); }
      }
    }
    if (Math.max(maxX - minX, maxY - minY) + 1 < minSide) {
      for (const i of members) plane[i] = 0;
      // Clear the antialiased fringe around the removed mark too.
      for (let y = Math.max(0, minY - 2); y <= Math.min(h - 1, maxY + 2); y++)
        for (let x = Math.max(0, minX - 2); x <= Math.min(w - 1, maxX + 2); x++)
          if (plane[y * w + x] < 90) plane[y * w + x] = 0;
    }
  }
}

function bounds(plane: Uint8ClampedArray, w: number, h: number) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (plane[y * w + x] > 90) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? { x0: 0, y0: 0, x1: w - 1, y1: h - 1 } : { x0, y0, x1, y1 };
}

async function render(src: string, boxW: number, boxH: number, dpr: number, opts: Required<InkOptions>): Promise<string> {
  const img = await loadImage(src);
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const rgba = ctx.getImageData(0, 0, W, H).data;

  // Luminance plane; invert dark-on-light sources by sampling the border.
  const lum = new Uint8ClampedArray(W * H);
  let border = 0, borderN = 0;
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    lum[i] = (rgba[p] * 54 + rgba[p + 1] * 183 + rgba[p + 2] * 19) >> 8;
  }
  for (let x = 0; x < W; x++) { border += lum[x] + lum[(H - 1) * W + x]; borderN += 2; }
  for (let y = 0; y < H; y++) { border += lum[y * W] + lum[y * W + W - 1]; borderN += 2; }
  if (border / borderN > 127) for (let i = 0; i < lum.length; i++) lum[i] = 255 - lum[i];
  // Remove paper noise / JPEG grey so the black stays black (transparent on glass).
  for (let i = 0; i < lum.length; i++) lum[i] = lum[i] < 40 ? 0 : lum[i];

  const outW = Math.max(1, Math.round(boxW * dpr)), outH = Math.max(1, Math.round(boxH * dpr));
  const fitScale = (w: number, h: number) => Math.min(outW / w, outH / h);

  // First pass: estimate the display scale from the drawing's extent, drop marks
  // that would be under ~4 display px, then crop again to what remains.
  const first = bounds(lum, W, H);
  const estScale = fitScale(first.x1 - first.x0 + 1, first.y1 - first.y0 + 1);
  removeSpecks(lum, W, H, Math.ceil((opts.minDetail * dpr) / estScale));
  let { x0, y0, x1, y1 } = bounds(lum, W, H);
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.01);
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const scale = fitScale(cw, ch);
  const dw = Math.max(1, Math.round(cw * scale)), dh = Math.max(1, Math.round(ch * scale));

  // Stroke that survives the downscale: source lines are ~1.5 px wide.
  const wantSrc = (opts.stroke * dpr) / scale;
  const r = Math.max(0, Math.round((wantSrc - 1.5) / 2));
  const crop = new Uint8ClampedArray(cw * ch);
  for (let y = 0; y < ch; y++) crop.set(lum.subarray((y + y0) * W + x0, (y + y0) * W + x0 + cw), y * cw);
  const thick = dilate(crop, cw, ch, r);

  const big = document.createElement('canvas');
  big.width = cw; big.height = ch;
  const bctx = big.getContext('2d')!;
  const bdata = bctx.createImageData(cw, ch);
  for (let i = 0, p = 0; i < thick.length; i++, p += 4) {
    bdata.data[p] = bdata.data[p + 1] = bdata.data[p + 2] = thick[i]; bdata.data[p + 3] = 255;
  }
  bctx.putImageData(bdata, 0, 0);

  // Step down by halves for a clean average, then finish at the exact size.
  let cur: HTMLCanvasElement = big;
  while (cur.width / 2 > dw && cur.height / 2 > dh) {
    const n = document.createElement('canvas');
    n.width = Math.round(cur.width / 2); n.height = Math.round(cur.height / 2);
    const nctx = n.getContext('2d')!;
    nctx.imageSmoothingQuality = 'high';
    nctx.drawImage(cur, 0, 0, n.width, n.height);
    cur = n;
  }
  const out = document.createElement('canvas');
  out.width = dw; out.height = dh;
  const octx = out.getContext('2d', { willReadFrequently: true })!;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(cur, 0, 0, dw, dh);
  const od = octx.getImageData(0, 0, dw, dh);
  for (let p = 0; p < od.data.length; p += 4) {
    const v = Math.min(255, od.data[p] * opts.gain);
    od.data[p] = od.data[p + 1] = od.data[p + 2] = v;
  }
  octx.putImageData(od, 0, 0);
  const blob = await new Promise<Blob | null>(res => out.toBlob(res, 'image/png'));
  if (!blob) throw new Error('Could not encode diagram');
  return URL.createObjectURL(blob);
}

/** Cached per source and rendered size. Resolves to an object URL. */
export function inkify(src: string, boxW: number, boxH: number, dpr = window.devicePixelRatio || 1, options: InkOptions = {}): Promise<string> {
  const opts = { stroke: options.stroke ?? 1.7, gain: options.gain ?? 2.2, minDetail: options.minDetail ?? 4.5 };
  const key = `${src}|${Math.round(boxW)}x${Math.round(boxH)}@${dpr}|${opts.stroke}|${opts.gain}|${opts.minDetail}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = render(src, boxW, boxH, dpr, opts);
    hit.catch(() => cache.delete(key));
    cache.set(key, hit);
  }
  return hit;
}
