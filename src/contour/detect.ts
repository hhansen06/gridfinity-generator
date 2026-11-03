// Finds a portrait A4 sheet in a photo, rectifies it to millimeters and traces
// the outline of the object lying on it.

export type Pt = [number, number];

export const PAPER: Pt = [210, 297];
// Resolution of the rectified sheet.
export const PX_PER_MM = 3;
const MAX_PHOTO = 2000;
// Working size for finding the sheet.
const PAPER_SEARCH = 400;
// Band along the paper edge that is ignored (shadows, imperfect corners).
const EDGE_MARGIN = 5;
const BG_BLOCK = 20;
const CLOSE_RADIUS = 1;
const SIMPLIFY = 0.8;
const MAX_POINTS = 60;
// Objects smaller than this (mm²) are dirt or noise.
const MIN_OBJECT = 100;
const MAX_OBJECTS = 20;

export interface Photo {
  canvas: HTMLCanvasElement;
  data: ImageData;
}

export async function loadPhoto(file: File): Promise<Photo> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('Das Bild konnte nicht gelesen werden (JPG, PNG oder WebP verwenden).');
  }
  const scale = Math.min(1, MAX_PHOTO / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return { canvas, data: ctx.getImageData(0, 0, canvas.width, canvas.height) };
}

// ---------- Sheet ----------

// Corners in photo pixels, clockwise starting top left of the portrait sheet,
// or null if no sheet stands out.
export function findPaper(img: ImageData): Pt[] | null {
  const step = Math.max(1, Math.ceil(Math.max(img.width, img.height) / PAPER_SEARCH));
  const w = Math.floor(img.width / step);
  const h = Math.floor(img.height / step);
  // White paper: bright and colorless.
  const score = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * step * img.width + x * step) * 4;
      const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      score[y * w + x] = clamp(lum - 1.5 * sat, 0, 255);
    }
  }
  const t = otsu(score);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = score[i] > t ? 1 : 0;
  const comp = largestComponent(mask, w, h);
  if (comp.size < 0.05 * w * h) return null;

  const boundary: Pt[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!comp.mask[y * w + x]) continue;
      const edge =
        x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
        !comp.mask[y * w + x - 1] || !comp.mask[y * w + x + 1] || !comp.mask[(y - 1) * w + x] || !comp.mask[(y + 1) * w + x];
      if (edge) boundary.push([x + 0.5, y + 0.5]);
    }
  }
  const quad = reduceToQuad(convexHull(boundary));
  if (quad.length !== 4 || Math.abs(polygonArea(quad)) < 0.05 * w * h) return null;
  const rough = orderCorners(quad.map(([x, y]): Pt => [x * step, y * step]));
  return refineCorners(img, rough, 2 * step + 2) ?? rough;
}

// The coarse search is off by up to a few pixels. Find the paper edge on the
// full image along each side, fit lines and intersect them.
function refineCorners(img: ImageData, q: Pt[], reach: number): Pt[] | null {
  const score = (x: number, y: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) return 0;
    const i = (yi * img.width + xi) * 4;
    const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
    return 0.299 * r + 0.587 * g + 0.114 * b - 1.5 * (Math.max(r, g, b) - Math.min(r, g, b));
  };
  const cx = q.reduce((a, p) => a + p[0], 0) / 4;
  const cy = q.reduce((a, p) => a + p[1], 0) / 4;
  const lines: { p: Pt; d: Pt }[] = [];
  for (let k = 0; k < 4; k++) {
    const a = q[k];
    const b = q[(k + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const d: Pt = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    // Normal pointing out of the sheet.
    let nrm: Pt = [d[1], -d[0]];
    if (nrm[0] * ((a[0] + b[0]) / 2 - cx) + nrm[1] * ((a[1] + b[1]) / 2 - cy) < 0) nrm = [-nrm[0], -nrm[1]];
    const found: Pt[] = [];
    const samples = Math.min(200, Math.floor(len / 2));
    for (let s = 0; s < samples; s++) {
      const t = 0.1 + (0.8 * s) / Math.max(1, samples - 1);
      const base: Pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      // Walk outward from inside the sheet; take the first drop below the
      // level halfway between paper and background.
      let prev = score(base[0] - nrm[0] * reach, base[1] - nrm[1] * reach);
      const outside = score(base[0] + nrm[0] * reach, base[1] + nrm[1] * reach);
      if (prev - outside < 30) continue;
      const threshold = (prev + outside) / 2;
      for (let o = -reach + 0.5; o <= reach; o += 0.5) {
        const v = score(base[0] + nrm[0] * o, base[1] + nrm[1] * o);
        if (prev > threshold && v <= threshold) {
          const f = (prev - threshold) / (prev - v);
          const off = o - 0.5 + 0.5 * f;
          found.push([base[0] + nrm[0] * off, base[1] + nrm[1] * off]);
          break;
        }
        prev = v;
      }
    }
    if (found.length < 10) return null;
    lines.push(fitLine(found));
  }
  const out: Pt[] = [];
  for (let k = 0; k < 4; k++) {
    const p = intersect(lines[(k + 3) % 4], lines[k]);
    if (!p || Math.hypot(p[0] - q[k][0], p[1] - q[k][1]) > 3 * reach) return null;
    out.push(p);
  }
  return out;
}

// Total least squares line through the points, robust against a few outliers
// (an object touching the edge) by refitting without the worst tenth.
function fitLine(pts: Pt[]): { p: Pt; d: Pt } {
  const fit = (pts: Pt[]) => {
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const [x, y] of pts) {
      sxx += (x - mx) ** 2;
      syy += (y - my) ** 2;
      sxy += (x - mx) * (y - my);
    }
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { p: [mx, my] as Pt, d: [Math.cos(angle), Math.sin(angle)] as Pt };
  };
  let line = fit(pts);
  for (let round = 0; round < 2; round++) {
    const dist = (q: Pt) => Math.abs((q[0] - line.p[0]) * line.d[1] - (q[1] - line.p[1]) * line.d[0]);
    const kept = [...pts].sort((a, b) => dist(a) - dist(b)).slice(0, Math.ceil(pts.length * 0.9));
    line = fit(kept);
  }
  return line;
}

function intersect(l1: { p: Pt; d: Pt }, l2: { p: Pt; d: Pt }): Pt | null {
  const den = l1.d[0] * l2.d[1] - l1.d[1] * l2.d[0];
  if (Math.abs(den) < 1e-6) return null;
  const t = ((l2.p[0] - l1.p[0]) * l2.d[1] - (l2.p[1] - l1.p[1]) * l2.d[0]) / den;
  return [l1.p[0] + l1.d[0] * t, l1.p[1] + l1.d[1] * t];
}

// Clockwise (in image coordinates) from the top left; the first edge is a
// short side so the sheet reads as portrait.
export function orderCorners(pts: Pt[]): Pt[] {
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const sorted = [...pts].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  const start = sorted.reduce((best, p, i) => (p[0] + p[1] < sorted[best][0] + sorted[best][1] ? i : best), 0);
  let q = [...sorted.slice(start), ...sorted.slice(0, start)];
  const d = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  if (d(q[0], q[1]) + d(q[2], q[3]) > d(q[1], q[2]) + d(q[3], q[0])) q = [q[1], q[2], q[3], q[0]];
  return q;
}

// ---------- Rectification ----------

export function rectify(img: ImageData, corners: Pt[]): ImageData {
  const [pw, ph] = PAPER;
  const H = homography([[0, 0], [pw, 0], [pw, ph], [0, ph]], corners);
  const w = pw * PX_PER_MM;
  const h = ph * PX_PER_MM;
  const out = new ImageData(w, h);
  const src = img.data;
  const sw = img.width;
  const sh = img.height;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const mx = (x + 0.5) / PX_PER_MM;
      const my = (y + 0.5) / PX_PER_MM;
      const k = H[6] * mx + H[7] * my + 1;
      const u = clamp((H[0] * mx + H[1] * my + H[2]) / k - 0.5, 0, sw - 1.001);
      const v = clamp((H[3] * mx + H[4] * my + H[5]) / k - 0.5, 0, sh - 1.001);
      const x0 = Math.floor(u);
      const y0 = Math.floor(v);
      const fx = u - x0;
      const fy = v - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + sw * 4;
      const i11 = i01 + 4;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c] * (1 - fx) + src[i10 + c] * fx;
        const bottom = src[i01 + c] * (1 - fx) + src[i11 + c] * fx;
        out.data[o + c] = top * (1 - fy) + bottom * fy;
      }
      out.data[o + 3] = 255;
    }
  }
  return out;
}

// Maps `from` onto `to` (four point pairs); returns the 8 free coefficients.
function homography(from: Pt[], to: Pt[]): number[] {
  const rows: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [u, v] = to[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let pivot = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(rows[r][c]) > Math.abs(rows[pivot][c])) pivot = r;
    [rows[c], rows[pivot]] = [rows[pivot], rows[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = rows[r][c] / rows[c][c];
      for (let k = c; k < 9; k++) rows[r][k] -= f * rows[c][k];
    }
  }
  return rows.map((r, i) => r[8] / r[i]);
}

// ---------- Object ----------

// Outlines in paper millimeters (y down) of all objects on the sheet, largest
// first. Sensitivity 0…100, 50 uses the automatic threshold.
export function detectObjects(img: ImageData, sensitivity: number): Pt[][] {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const lum = new Float32Array(n);
  const sat = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const [r, g, b] = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    sat[i] = Math.max(r, g, b) - Math.min(r, g, b);
  }
  const margin = EDGE_MARGIN * PX_PER_MM;
  const inside = (x: number, y: number) => x >= margin && y >= margin && x < w - margin && y < h - margin;

  // Paper brightness varies with the lighting; estimate it per block.
  const bg = background(lum, w, h, inside);
  const satPaper = percentile(sat, (i) => inside(i % w, Math.floor(i / w)), 0.5);
  const score = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!inside(x, y)) continue;
      score[i] = clamp(bg(x, y) - lum[i] + Math.max(0, sat[i] - satPaper), 0, 255);
    }
  }
  const t = Math.max(12, otsu(score)) * 2 ** ((50 - sensitivity) / 35);
  let mask: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = score[i] > t ? 1 : 0;

  const r = Math.round(CLOSE_RADIUS * PX_PER_MM);
  mask = morph(morph(mask, w, h, r, true), w, h, r, false);
  mask = fillHoles(mask, w, h);
  const { label, sizes } = labelComponents(mask, w, h);
  const ids = sizes
    .map((size, id) => ({ size, id }))
    .filter((c) => c.id > 0 && c.size >= MIN_OBJECT * PX_PER_MM * PX_PER_MM)
    .sort((a, b) => b.size - a.size)
    .slice(0, MAX_OBJECTS);
  const outlines: Pt[][] = [];
  for (const { id } of ids) {
    const comp = new Uint8Array(n);
    for (let i = 0; i < n; i++) comp[i] = label[i] === id ? 1 : 0;
    const loops = traceLoops(comp, w, h);
    if (!loops.length) continue;
    const loop = loops.reduce((a, b) => (Math.abs(polygonArea(b)) > Math.abs(polygonArea(a)) ? b : a));
    const mm = loop.map(([x, y]): Pt => [x / PX_PER_MM, y / PX_PER_MM]);
    let tolerance = SIMPLIFY;
    let simple = simplifyClosed(mm, tolerance);
    while (simple.length > MAX_POINTS) simple = simplifyClosed(mm, (tolerance *= 1.4));
    if (simple.length >= 3) outlines.push(simple);
  }
  return outlines;
}

function background(lum: Float32Array, w: number, h: number, inside: (x: number, y: number) => boolean) {
  const b = BG_BLOCK * PX_PER_MM;
  const bw = Math.ceil(w / b);
  const bh = Math.ceil(h / b);
  const values = new Float32Array(bw * bh).fill(NaN);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const hist = new Uint32Array(256);
      let count = 0;
      for (let y = by * b; y < Math.min(h, (by + 1) * b); y++) {
        for (let x = bx * b; x < Math.min(w, (bx + 1) * b); x++) {
          if (!inside(x, y)) continue;
          hist[Math.round(lum[y * w + x])]++;
          count++;
        }
      }
      if (count > b) values[by * bw + bx] = histPercentile(hist, count, 0.9);
    }
  }
  // Blocks covered by a dark object say nothing about the paper: replace them
  // by their neighbors.
  const valid = [...values].filter((v) => !isNaN(v)).sort((a, b) => a - b);
  const median = valid[Math.floor(valid.length / 2)] ?? 255;
  for (let i = 0; i < values.length; i++) if (values[i] < median - 40) values[i] = NaN;
  for (let pass = 0; pass < bw + bh && values.some(isNaN); pass++) {
    const next = values.slice();
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        if (!isNaN(values[y * bw + x])) continue;
        const around = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]
          .filter(([nx, ny]) => nx >= 0 && ny >= 0 && nx < bw && ny < bh)
          .map(([nx, ny]) => values[ny * bw + nx])
          .filter((v) => !isNaN(v));
        if (around.length) next[y * bw + x] = around.reduce((a, v) => a + v, 0) / around.length;
      }
    }
    values.set(next);
  }
  for (let i = 0; i < values.length; i++) if (isNaN(values[i])) values[i] = median;
  // Bilinear between block centers.
  return (x: number, y: number) => {
    const fx = clamp(x / b - 0.5, 0, bw - 1);
    const fy = clamp(y / b - 0.5, 0, bh - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, bw - 1);
    const y1 = Math.min(y0 + 1, bh - 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const v = (xx: number, yy: number) => values[yy * bw + xx];
    return (v(x0, y0) * (1 - tx) + v(x1, y0) * tx) * (1 - ty) + (v(x0, y1) * (1 - tx) + v(x1, y1) * tx) * ty;
  };
}

// ---------- Image helpers ----------

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

function histPercentile(hist: Uint32Array, count: number, q: number) {
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= q * count) return v;
  }
  return 255;
}

function percentile(values: Float32Array, use: (i: number) => boolean, q: number) {
  const hist = new Uint32Array(256);
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    if (!use(i)) continue;
    hist[clamp(Math.round(values[i]), 0, 255)]++;
    count++;
  }
  return count ? histPercentile(hist, count, q) : 0;
}

function otsu(values: Uint8Array): number {
  const hist = new Float64Array(256);
  for (const v of values) hist[v]++;
  const total = values.length;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0;
  let weightB = 0;
  let best = 0;
  let first = 127;
  let last = 127;
  for (let v = 0; v < 256; v++) {
    weightB += hist[v];
    if (!weightB) continue;
    const weightF = total - weightB;
    if (!weightF) break;
    sumB += v * hist[v];
    const between = weightB * weightF * (sumB / weightB - (sum - sumB) / weightF) ** 2;
    if (between > best * (1 + 1e-9)) {
      best = between;
      first = last = v;
    } else if (between >= best * (1 - 1e-9)) {
      last = v;
    }
  }
  // Empty histogram ranges give equal scores; take the middle of the gap.
  return Math.floor((first + last) / 2);
}

// Square dilation (grow) or erosion, done separably.
function morph(mask: Uint8Array, w: number, h: number, r: number, grow: boolean): Uint8Array {
  const pass = (src: Uint8Array, horizontal: boolean) => {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = grow ? 0 : 1;
        for (let d = -r; d <= r; d++) {
          const xx = horizontal ? x + d : x;
          const yy = horizontal ? y : y + d;
          const s = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : src[yy * w + xx];
          if (grow ? s : !s) {
            v = grow ? 1 : 0;
            break;
          }
        }
        out[y * w + x] = v;
      }
    }
    return out;
  };
  return pass(pass(mask, true), false);
}

// Everything not reachable from the image border becomes part of the mask.
function fillHoles(mask: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(mask.length);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!mask[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < (h - 1) * w) push(i + w);
  }
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = outside[i] ? 0 : 1;
  return out;
}

function largestComponent(mask: Uint8Array, w: number, h: number): { mask: Uint8Array; size: number } {
  const { label, sizes } = labelComponents(mask, w, h);
  let best = 0;
  for (let id = 1; id < sizes.length; id++) if (sizes[id] > sizes[best]) best = id;
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = label[i] === best && best ? 1 : 0;
  return { mask: out, size: best ? sizes[best] : 0 };
}

// 4-connected components; sizes[id] is the pixel count of component id (from 1).
function labelComponents(mask: Uint8Array, w: number, h: number): { label: Int32Array; sizes: number[] } {
  const label = new Int32Array(mask.length);
  const sizes = [0];
  let next = 0;
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    const id = ++next;
    let size = 0;
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      const x = i % w;
      const neighbors = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < (h - 1) * w ? i + w : -1];
      for (const j of neighbors) {
        if (j >= 0 && mask[j] && !label[j]) {
          label[j] = id;
          stack.push(j);
        }
      }
    }
    sizes.push(size);
  }
  return { label, sizes };
}

// Closed pixel-edge loops around the mask, in pixel corner coordinates.
function traceLoops(mask: Uint8Array, w: number, h: number): Pt[][] {
  const W = w + 1;
  const edges = new Map<number, number[]>();
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const k = y0 * W + x0;
    const list = edges.get(k);
    if (list) list.push(y1 * W + x1);
    else edges.set(k, [y1 * W + x1]);
  };
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (!at(x, y - 1)) add(x, y, x + 1, y);
      if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!at(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  const loops: Pt[][] = [];
  for (const start of edges.keys()) {
    while (edges.get(start)?.length) {
      const loop: Pt[] = [];
      let k = start;
      do {
        loop.push([k % W, Math.floor(k / W)]);
        const out = edges.get(k)!;
        k = out.pop()!;
      } while (k !== start && edges.get(k)?.length);
      loops.push(loop);
    }
  }
  return loops;
}

// ---------- Polygon helpers ----------

export function polygonArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (const p of pts.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// Drops the hull vertex that costs the least area until four remain; for a
// sheet of paper these are its corners.
function reduceToQuad(hull: Pt[]): Pt[] {
  const pts = [...hull];
  const cost = (i: number) => {
    const a = pts[(i - 1 + pts.length) % pts.length];
    const b = pts[i];
    const c = pts[(i + 1) % pts.length];
    return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  };
  while (pts.length > 4) {
    let min = 0;
    for (let i = 1; i < pts.length; i++) if (cost(i) < cost(min)) min = i;
    pts.splice(min, 1);
  }
  return pts;
}

function simplifyClosed(pts: Pt[], tolerance: number): Pt[] {
  if (pts.length < 4) return pts;
  // Split at the point farthest from the first one.
  let far = 0;
  let farDist = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > farDist) {
      farDist = d;
      far = i;
    }
  }
  const a = douglasPeucker(pts.slice(0, far + 1), tolerance);
  const b = douglasPeucker([...pts.slice(far), pts[0]], tolerance);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function douglasPeucker(pts: Pt[], tolerance: number): Pt[] {
  if (pts.length < 3) return pts;
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  const len = Math.hypot(bx - ax, by - ay) || 1;
  let index = 0;
  let max = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
    if (d > max) {
      max = d;
      index = i;
    }
  }
  if (max <= tolerance) return [pts[0], pts[pts.length - 1]];
  return [...douglasPeucker(pts.slice(0, index + 1), tolerance).slice(0, -1), ...douglasPeucker(pts.slice(index), tolerance)];
}
