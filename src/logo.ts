import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import type { Vec2 } from 'manifold-3d';
import type { Shape2D } from './geometry/gridfinity';

const RASTER_RESOLUTION = 120;

type SvgStyle = { fill?: string; fillRule?: string; fillOpacity?: number };

// Dark fills become solid; light fills (typically white) drawn on top of them
// cut holes, mirroring how the logo looks when printed on white.
export function svgToShape(svgText: string): Shape2D {
  const data = new SVGLoader().parse(svgText);
  const parts: Shape2D['parts'] = [];
  for (const path of data.paths) {
    const style = (path.userData as { style?: SvgStyle } | undefined)?.style ?? {};
    if (style.fill === 'none' || style.fill === 'transparent' || style.fillOpacity === 0) continue;
    // SVG y axis points down.
    const polygons = path.subPaths
      .map((sub) => sub.getPoints(12).map((p): Vec2 => [p.x, -p.y]))
      .filter((pts) => pts.length >= 3);
    if (polygons.length === 0) continue;
    const { r, g, b } = path.color;
    parts.push({
      polygons,
      fillRule: style.fillRule === 'evenodd' ? 'EvenOdd' : 'NonZero',
      subtract: 0.299 * r + 0.587 * g + 0.114 * b > 0.85,
    });
  }
  if (parts.every((p) => p.subtract)) parts.forEach((p) => (p.subtract = false));
  if (parts.length === 0) throw new Error('Das SVG enthält keine gefüllten Flächen (reine Konturlinien werden nicht unterstützt).');
  return { parts };
}

export async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Dark, opaque pixels become solid; runs of equal pixels are merged into
// rectangles to keep the polygon count low.
export function rasterToShape(img: HTMLImageElement, threshold: number, invert: boolean): Shape2D {
  const scale = RASTER_RESOLUTION / Math.max(img.naturalWidth, img.naturalHeight);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const solid = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    if (data[i + 3] < 128) return false;
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    return lum < threshold !== invert;
  };

  const rects: [number, number, number, number][] = [];
  let open = new Map<string, number>();
  for (let y = 0; y <= h; y++) {
    const next = new Map<string, number>();
    let x = 0;
    while (y < h && x < w) {
      if (!solid(x, y)) {
        x++;
        continue;
      }
      const start = x;
      while (x < w && solid(x, y)) x++;
      const key = `${start}:${x}`;
      next.set(key, open.get(key) ?? y);
      open.delete(key);
    }
    for (const [key, y0] of open) {
      const [x0, x1] = key.split(':').map(Number);
      rects.push([x0, y0, x1, y]);
    }
    open = next;
  }

  if (rects.length === 0) throw new Error('Im Bild wurden keine Flächen erkannt. Schwellwert anpassen oder „Invertieren“ nutzen.');
  const polygons = rects.map(([x0, y0, x1, y1]): Vec2[] => [
    [x0, -y1],
    [x1, -y1],
    [x1, -y0],
    [x0, -y0],
  ]);
  return { parts: [{ polygons, fillRule: 'Positive' }] };
}
