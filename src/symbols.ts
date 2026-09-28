import type { Vec2 } from 'manifold-3d';
import type { Shape2D } from './geometry/gridfinity';

export interface SymbolDef {
  id: string;
  name: string;
  shape: Shape2D;
  // Maximum width relative to the label height.
  aspect: number;
}

type Poly = Vec2[];
type Part = Shape2D['parts'][number];

const add = (...polys: Poly[]): Part[] => polys.map((p) => ({ polygons: [p], fillRule: 'NonZero' }));
const sub = (...polys: Poly[]): Part[] => polys.map((p) => ({ polygons: [p], fillRule: 'NonZero', subtract: true }));
const shape = (...parts: Part[][]): Shape2D => ({ parts: parts.flat() });

const rad = (deg: number) => (deg * Math.PI) / 180;

const rect = (x0: number, y0: number, x1: number, y1: number): Poly => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

const polar = (radius: (t: number) => number, cx = 0, cy = 0, n = 96): Poly =>
  Array.from({ length: n }, (_, i) => {
    const t = (i / n) * 2 * Math.PI;
    const r = radius(t);
    return [cx + r * Math.cos(t), cy + r * Math.sin(t)];
  });

const circle = (r: number, cx = 0, cy = 0) => polar(() => r, cx, cy, 64);

const ngon = (n: number, r: number, startDeg = 90): Poly =>
  Array.from({ length: n }, (_, i) => {
    const t = rad(startDeg) + (i / n) * 2 * Math.PI;
    return [r * Math.cos(t), r * Math.sin(t)];
  });

const star = (points: number, outer: number, inner: number): Poly =>
  Array.from({ length: points * 2 }, (_, i) => {
    const t = rad(90) + (i / (points * 2)) * 2 * Math.PI;
    const r = i % 2 ? inner : outer;
    return [r * Math.cos(t), r * Math.sin(t)];
  });

const rotate = (p: Poly, deg: number): Poly => {
  const c = Math.cos(rad(deg));
  const s = Math.sin(rad(deg));
  return p.map(([x, y]) => [x * c - y * s, x * s + y * c]);
};

// ---------- Antriebe: Draufsicht auf den Schraubenkopf ----------

const disc = add(circle(1));
const torxProfile = polar((t) => 0.5 + 0.13 * Math.cos(6 * t));
const drive = (id: string, name: string, ...cut: Part[][]): SymbolDef => ({
  id,
  name,
  shape: shape(disc, ...cut),
  aspect: 1,
});

export const DRIVES: SymbolDef[] = [
  drive('slot', 'Schlitz', sub(rect(-1.2, -0.15, 1.2, 0.15))),
  drive('phillips', 'Kreuzschlitz (PH)', sub(rect(-0.62, -0.15, 0.62, 0.15), rect(-0.15, -0.62, 0.15, 0.62))),
  drive(
    'pozidriv',
    'Pozidriv (PZ)',
    sub(
      rect(-0.62, -0.15, 0.62, 0.15),
      rect(-0.15, -0.62, 0.15, 0.62),
      rotate(rect(-0.52, -0.05, 0.52, 0.05), 45),
      rotate(rect(-0.52, -0.05, 0.52, 0.05), -45),
    ),
  ),
  drive('combo', 'Schlitz/Kreuz', sub(rect(-1.2, -0.12, 1.2, 0.12), rect(-0.15, -0.55, 0.15, 0.55))),
  drive('hex', 'Innensechskant', sub(ngon(6, 0.56, 0))),
  drive('torx', 'Torx (TX)', sub(torxProfile)),
  drive('torx-tr', 'Torx mit Stift (TR)', sub(torxProfile), add(circle(0.15))),
  drive('square', 'Innenvierkant', sub(rect(-0.4, -0.4, 0.4, 0.4))),
  drive('xzn', 'Vielzahn (XZN)', sub(star(12, 0.62, 0.5))),
  drive('pentagon', 'Fünfkant', sub(ngon(5, 0.58))),
  drive('triangle', 'Dreikant', sub(ngon(3, 0.62))),
  drive(
    'triwing',
    'Tri-Wing',
    sub(circle(0.22), ...[90, 210, 330].map((a) => rotate(rect(0, -0.15, 0.66, 0.15), a))),
  ),
  drive('spanner', 'Zweiloch', sub(circle(0.15, -0.4, 0), circle(0.15, 0.4, 0))),
];

// ---------- Kopfformen: Seitenansicht, Kopf links, Schaft rechts ----------

const SHANK_LENGTH = 1.9;

const threadedShank = (start: number): Poly => {
  const core = 0.42;
  const crest = 0.54;
  const pitch = 0.3;
  const end = start + SHANK_LENGTH;
  const bottom: Poly = [];
  const top: Poly = [];
  for (let x = start; x < end - pitch / 2; x += pitch) {
    bottom.push([x, -core], [x + pitch / 2, -crest]);
    top.unshift([x, core], [x + pitch / 2, crest]);
  }
  return [[start - 0.05, -core], ...bottom, [end, -core], [end, core], ...top, [start - 0.05, core]];
};

// Rounded head: straight sides of length `side`, then a superellipse dome
// ending at x = 0. Larger `n` gives a flatter top.
const dome = (base: number, side: number, halfWidth: number, n: number): Poly => {
  const cx = base - side;
  const pts: Poly = [
    [base, -halfWidth],
    [base, halfWidth],
    [cx, halfWidth],
  ];
  for (let i = 1; i < 32; i++) {
    const t = rad(90 + (i / 32) * 180);
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push([cx + cx * Math.sign(c) * Math.abs(c) ** (2 / n), halfWidth * Math.sign(s) * Math.abs(s) ** (2 / n)]);
  }
  pts.push([cx, -halfWidth]);
  return pts;
};

const countersunk: Poly = [
  [0, -1],
  [0.1, -1],
  [0.62, -0.42],
  [0.62, 0.42],
  [0.1, 1],
  [0, 1],
];

const hexFaces = (x0: number, x1: number, y: number) =>
  sub(rect(x0 - 0.01, y - 0.045, x1 + 0.01, y + 0.045), rect(x0 - 0.01, -y - 0.045, x1 + 0.01, -y + 0.045));

// Side-view symbol whose allowed width follows its own proportions.
const sideView = (id: string, name: string, ...parts: Part[][]): SymbolDef => {
  const s = shape(...parts);
  const pts = s.parts.flatMap((p) => p.polygons.flat());
  const xs = pts.map(([x]) => x);
  const ys = pts.map(([, y]) => y);
  const aspect = (Math.max(...xs) - Math.min(...xs) + 0.3) / (Math.max(...ys) - Math.min(...ys));
  return { id, name, shape: s, aspect };
};

const head = (id: string, name: string, headEnd: number, ...parts: Part[][]): SymbolDef =>
  sideView(id, name, add(threadedShank(headEnd)), ...parts);

export const HEADS: SymbolDef[] = [
  head('flat', 'Senkkopf', 0.62, add(countersunk)),
  head('oval', 'Linsensenkkopf', 0.62, add(countersunk), add(polar((t) => 1 / Math.hypot(Math.cos(t) / 0.28, Math.sin(t))))),
  head('pan', 'Flachkopf (Pan)', 0.66, add(dome(0.66, 0.3, 1, 3))),
  head('truss', 'Flachrundkopf breit (Truss)', 0.5, add(dome(0.5, 0.06, 1.3, 2.4))),
  head('round', 'Halbrundkopf', 0.8, add(dome(0.8, 0, 1, 2))),
  head('button', 'Linsenkopf (Button)', 0.55, add(dome(0.55, 0.06, 1.05, 2.2))),
  head('socket', 'Zylinderkopf', 1, add([
    [0.12, -0.8],
    [1, -0.8],
    [1, 0.8],
    [0.12, 0.8],
    [0, 0.68],
    [0, -0.68],
  ]), sub(...[-0.4, 0, 0.4].map((y) => rect(0.16, y - 0.05, 1.01, y + 0.05)))),
  head('hex-head', 'Sechskant', 0.7, add(rect(0, -1, 0.7, 1)), hexFaces(0, 0.7, 0.5)),
  head('hex-washer', 'Sechskant mit Bund', 0.8, add(rect(0, -0.85, 0.62, 0.85), rect(0.58, -1.15, 0.8, 1.15)), hexFaces(0, 0.58, 0.43)),
  head(
    'hex-washer-slot',
    'Sechskant mit Bund und Schlitz',
    0.8,
    add(rect(0, -0.85, 0.62, 0.85), rect(0.58, -1.15, 0.8, 1.15)),
    hexFaces(0.3, 0.58, 0.43),
    sub(rect(-0.01, -0.16, 0.3, 0.16)),
  ),
  // Cable stub, plastic collar with chamfer, metal crimp sleeve.
  sideView(
    'ferrule',
    'Aderendhülse',
    add(
      rect(-0.75, -0.42, -0.08, 0.42),
      [
        [0, -0.8],
        [0.75, -0.8],
        [0.95, -0.52],
        [0.95, 0.52],
        [0.75, 0.8],
        [0, 0.8],
      ],
      rect(0.9, -0.32, 2.7, 0.32),
    ),
  ),
];

export const findSymbol = (list: SymbolDef[], id: string) => list.find((s) => s.id === id) ?? null;

export function symbolToSvg(s: SymbolDef): string {
  const pts = s.shape.parts.flatMap((p) => p.polygons.flat());
  const xs = pts.map(([x]) => x);
  const ys = pts.map(([, y]) => y);
  const pad = 0.1;
  const x0 = Math.min(...xs) - pad;
  const y0 = Math.min(...ys) - pad;
  const w = Math.max(...xs) + pad - x0;
  const h = Math.max(...ys) + pad - y0;
  const paths = s.shape.parts
    .map((part) => {
      const d = part.polygons
        .map((poly) => 'M' + poly.map(([x, y]) => `${(x - x0).toFixed(3)} ${(h - (y - y0)).toFixed(3)}`).join('L') + 'Z')
        .join('');
      return `<path d="${d}" class="${part.subtract ? 'cut' : 'solid'}"/>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${w.toFixed(3)} ${h.toFixed(3)}" aria-hidden="true">${paths}</svg>`;
}
