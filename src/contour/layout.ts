import type { Vec2 } from 'manifold-3d';
import { CLEARANCE, GRID } from '../geometry/gridfinity';
import type { Pt } from './detect';

export type CutoutKind = 'rect' | 'circle' | 'grip';

// In paper millimeters, y pointing down; angle in degrees, clockwise on screen.
// Circles use w as diameter; grips are capsules w long and h wide.
export interface Cutout {
  id: string;
  kind: CutoutKind;
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
  depth: number;
}

// An object outline in paper millimeters; depth null uses the global depth.
export interface Contour {
  id: string;
  points: Pt[];
  depth: number | null;
}

// Center of the bounding box.
export function shapeCenter(pts: Pt[]): Pt {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

// Material kept between the pocket and the clipped wall.
const MIN_SIDE = 1.5;

export interface Layout {
  // Rotation of the paper content within the bin, degrees counterclockwise.
  rotation: number;
  // Paper point to bin coordinates (bin centered at the origin, y up).
  toBin(p: Pt): Vec2;
  toPaper(b: Vec2): Pt;
  // Size of everything that has to fit, in the bin frame.
  extent: [number, number];
}

const rotate = ([x, y]: Vec2, deg: number): Vec2 => {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
};

// Points that must lie inside the bin: the grown pocket plus rectangle and
// circle cutouts. Finger grips may reach into the wall, they are clipped.
export function fitPoints(pocket: Pt[][], cutouts: Cutout[]): Pt[] {
  const pts = pocket.flat();
  for (const c of cutouts) {
    if (c.kind === 'grip') continue;
    if (c.kind === 'circle') {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * 2 * Math.PI;
        pts.push([c.x + (Math.cos(a) * c.w) / 2, c.y + (Math.sin(a) * c.w) / 2]);
      }
    } else {
      pts.push(...cutoutCorners(c));
    }
  }
  return pts;
}

export function cutoutCorners(c: Cutout): Pt[] {
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sy]) => local(c, [(sx * c.w) / 2, (sy * c.h) / 2]));
}

// Local cutout coordinates to paper coordinates.
export function local(c: Pick<Cutout, 'x' | 'y' | 'angle'>, p: Pt): Pt {
  const [x, y] = rotate(p, c.angle);
  return [c.x + x, c.y + y];
}

export function toLocal(c: Pick<Cutout, 'x' | 'y' | 'angle'>, p: Pt): Pt {
  return rotate([p[0] - c.x, p[1] - c.y], -c.angle);
}

export function makeLayout(points: Pt[], rotation: number): Layout {
  const flipped = points.map(([x, y]) => rotate([x, -y], rotation));
  const xs = flipped.map((p) => p[0]);
  const ys = flipped.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = xs.length ? [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)] : [0, 0, 0, 0];
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    rotation,
    toBin: ([x, y]) => {
      const [rx, ry] = rotate([x, -y], rotation);
      return [rx - cx, ry - cy];
    },
    toPaper: ([x, y]) => {
      const [px, py] = rotate([x + cx, y + cy], -rotation);
      return [px, -py];
    },
    extent: [maxX - minX, maxY - minY],
  };
}

// Grid units needed for the given extent.
export function cellsFor(extent: number, inset: number): number {
  return Math.max(1, Math.ceil((extent + 2 * (inset + MIN_SIDE) + CLEARANCE) / GRID));
}

// Rotation (−90…90°) needing the fewest grid cells, then the least area.
export function bestRotation(points: Pt[], inset: number): number {
  let best = { rotation: 0, cells: Infinity, area: Infinity };
  for (let r = -90; r < 90; r++) {
    const [w, h] = makeLayout(points, r).extent;
    const cells = cellsFor(w, inset) * cellsFor(h, inset);
    const area = w * h;
    if (cells < best.cells || (cells === best.cells && area < best.area - 1e-6)) best = { rotation: r, cells, area };
  }
  return best.rotation;
}
