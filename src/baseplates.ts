import { GRID } from './geometry/gridfinity';

export type PadMode = 'none' | 'center' | 'start';

export interface DrawerParams {
  // Inner drawer size in mm.
  width: number;
  depth: number;
  // Total play left free per axis so the plates drop in easily.
  clearance: number;
  // Largest plate edge that fits on the print bed.
  bed: number;
  pad: PadMode;
  magnets: boolean;
}

export interface PlateType {
  // A, B, C … in order of first appearance.
  name: string;
  x: number;
  y: number;
  pad: { left: number; right: number; front: number; back: number };
  magnets: boolean;
  size: [number, number];
  // Centers of every copy in drawer coordinates (drawer centered at the origin);
  // alt marks every other plate in a checkerboard pattern.
  positions: { x: number; y: number; alt: boolean }[];
}

export interface DrawerLayout {
  cellsX: number;
  cellsY: number;
  // Free space per axis that is neither grid nor padding.
  gapX: number;
  gapY: number;
  plates: PlateType[];
  count: number;
}

interface AxisPiece {
  cells: number;
  padStart: number;
  padEnd: number;
}

const length = (p: AxisPiece) => p.cells * GRID + p.padStart + p.padEnd;
// Slivers thinner than this are not worth printing.
const MIN_PAD = 0.5;
const round = (v: number) => Math.round(v * 100) / 100;

// Splits one axis into as few pieces as fit the bed, with cell counts as even
// as possible. Leftover cells go either to the end pieces or to the inner ones,
// whichever fits and leaves fewer different pieces to print.
function splitAxis(cells: number, padStart: number, padEnd: number, bed: number): AxisPiece[] | null {
  for (let k = 1; k <= cells; k++) {
    const candidates = [true, false].map((endsFirst) => {
      const counts = Array<number>(k).fill(Math.floor(cells / k));
      const order = [...counts.keys()].sort((a, b) => (endsFirst ? -1 : 1) * (edgeness(a, k) - edgeness(b, k)));
      for (let i = 0; i < cells % k; i++) counts[order[i]]++;
      return counts.map((c, i) => ({
        cells: c,
        padStart: i === 0 ? padStart : 0,
        padEnd: i === k - 1 ? padEnd : 0,
      }));
    });
    const fitting = candidates.filter((pieces) => pieces.every((p) => length(p) <= bed));
    if (fitting.length) return fitting.sort((a, b) => variants(a) - variants(b))[0];
  }
  return null;
}

const variants = (pieces: AxisPiece[]) => new Set(pieces.map((p) => JSON.stringify(p))).size;

// 0 for inner pieces, 1 for one end, 2 for a single piece touching both.
const edgeness = (i: number, k: number) => Number(i === 0) + Number(i === k - 1);

function pads(free: number, mode: PadMode): [number, number] {
  if (mode === 'none') return [0, 0];
  if (mode === 'start') return free >= MIN_PAD ? [round(free), 0] : [0, 0];
  const half = free / 2;
  return half >= MIN_PAD ? [round(half), round(half)] : [0, 0];
}

export function layoutDrawer(d: DrawerParams): DrawerLayout | string {
  const usableX = d.width - d.clearance;
  const usableY = d.depth - d.clearance;
  const cellsX = Math.floor(usableX / GRID);
  const cellsY = Math.floor(usableY / GRID);
  if (cellsX < 1 || cellsY < 1) return `Die Schublade muss mindestens ${GRID + d.clearance} mm in jeder Richtung messen.`;

  const [left, right] = pads(usableX - cellsX * GRID, d.pad);
  const [front, back] = pads(usableY - cellsY * GRID, d.pad);
  const piecesX = splitAxis(cellsX, left, right, d.bed);
  const piecesY = splitAxis(cellsY, front, back, d.bed);
  if (!piecesX || !piecesY) return 'Das Druckbett ist zu klein für eine einzelne Rasterzelle mit Rand.';

  const totalX = piecesX.reduce((a, p) => a + length(p), 0);
  const totalY = piecesY.reduce((a, p) => a + length(p), 0);
  const types = new Map<string, PlateType>();
  let y0 = -totalY / 2;
  for (const [row, py] of piecesY.entries()) {
    let x0 = -totalX / 2;
    for (const [col, px] of piecesX.entries()) {
      const pad = { left: px.padStart, right: px.padEnd, front: py.padStart, back: py.padEnd };
      const key = JSON.stringify([px.cells, py.cells, pad]);
      let type = types.get(key);
      if (!type) {
        type = {
          name: String.fromCharCode(65 + types.size),
          x: px.cells,
          y: py.cells,
          pad,
          magnets: d.magnets,
          size: [length(px), length(py)],
          positions: [],
        };
        types.set(key, type);
      }
      type.positions.push({ x: x0 + length(px) / 2, y: y0 + length(py) / 2, alt: (row + col) % 2 === 1 });
      x0 += length(px);
    }
    y0 += length(py);
  }

  return {
    cellsX,
    cellsY,
    gapX: round(d.width - totalX),
    gapY: round(d.depth - totalY),
    plates: [...types.values()],
    count: piecesX.length * piecesY.length,
  };
}
