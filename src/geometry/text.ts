import type { Font, PathCommand } from 'opentype.js';
import type { Vec2 } from 'manifold-3d';
import type { Shape2D } from './gridfinity';

const FONT_SIZE = 100;
const LINE_HEIGHT = 1.15;
const CURVE_STEPS = 8;

export function textToShape(font: Font, text: string, align: 'left' | 'center'): Shape2D | null {
  const lines = text.split('\n').map((l) => l.trimEnd());
  const widths = lines.map((l) => font.getAdvanceWidth(l, FONT_SIZE));
  const maxWidth = Math.max(...widths);
  const contours: Vec2[][] = [];

  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const x = align === 'center' ? (maxWidth - widths[i]) / 2 : 0;
    const path = font.getPath(line, x, i * FONT_SIZE * LINE_HEIGHT, FONT_SIZE);
    contours.push(...flatten(path.commands));
  });

  if (contours.length === 0) return null;
  // Font coordinates grow downwards; flip so the text reads correctly from above.
  const flipped = contours.map((c) => c.map(([x, y]): Vec2 => [x, -y]));
  return { parts: [{ polygons: flipped, fillRule: 'NonZero' }] };
}

function flatten(commands: PathCommand[]): Vec2[][] {
  const contours: Vec2[][] = [];
  let current: Vec2[] = [];
  let last: Vec2 = [0, 0];
  const close = () => {
    if (current.length >= 3) contours.push(current);
    current = [];
  };

  for (const cmd of commands) {
    switch (cmd.type) {
      case 'M':
        close();
        last = [cmd.x, cmd.y];
        current.push(last);
        break;
      case 'L':
        last = [cmd.x, cmd.y];
        current.push(last);
        break;
      case 'Q': {
        const [x0, y0] = last;
        for (let s = 1; s <= CURVE_STEPS; s++) {
          const t = s / CURVE_STEPS;
          const u = 1 - t;
          current.push([u * u * x0 + 2 * u * t * cmd.x1 + t * t * cmd.x, u * u * y0 + 2 * u * t * cmd.y1 + t * t * cmd.y]);
        }
        last = [cmd.x, cmd.y];
        break;
      }
      case 'C': {
        const [x0, y0] = last;
        for (let s = 1; s <= CURVE_STEPS; s++) {
          const t = s / CURVE_STEPS;
          const u = 1 - t;
          const a = u * u * u;
          const b = 3 * u * u * t;
          const c = 3 * u * t * t;
          const d = t * t * t;
          current.push([
            a * x0 + b * cmd.x1 + c * cmd.x2 + d * cmd.x,
            a * y0 + b * cmd.y1 + c * cmd.y2 + d * cmd.y,
          ]);
        }
        last = [cmd.x, cmd.y];
        break;
      }
      case 'Z':
        close();
        break;
    }
  }
  close();
  return contours;
}
