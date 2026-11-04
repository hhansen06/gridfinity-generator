// The .gfkontur file: an editable contour bin as plain JSON. See
// docs/kontur-format.md for the specification.

import type { Pt } from './detect';
import type { Contour, Cutout } from './layout';

export const FILE_FORMAT = 'gridfinity-kontur';
export const FILE_VERSION = 1;
export const FILE_EXTENSION = '.gfkontur';

const FONTS = ['roboto', 'roboto-slab', 'roboto-mono', 'bebas'];
const MAX_CONTOURS = 200;
const MAX_POINTS = 2000;
const MAX_CUTOUTS = 500;
const MAX_TEXT = 200;
const MAX_PHOTO = 12_000_000;
// Only plain base64 images; the string ends up in an SVG attribute.
const PHOTO_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export type GridValue = number | 'auto';

export interface ProjectSettings {
  clearance: number;
  depth: number;
  rotation: number;
  grid: { x: GridValue; y: GridValue; z: GridValue };
  lip: boolean;
  magnets: boolean;
  colorFloor: boolean;
  sensitivity: number;
  colors: { body: string; accent: string };
}

export interface Project {
  photo: string | null;
  settings: ProjectSettings;
  contours: Contour[];
  cutouts: Cutout[];
}

// ---------- Writing ----------

const r2 = (v: number) => Math.round(v * 100) / 100;

export function serializeProject(p: Project): string {
  const cutouts = p.cutouts.map((c) => {
    const at = { x: r2(c.x), y: r2(c.y) };
    switch (c.kind) {
      case 'circle':
        return { type: 'circle', ...at, diameter: r2(c.w), depth: r2(c.depth) };
      case 'rect':
        return { type: 'rect', ...at, width: r2(c.w), height: r2(c.h), angle: r2(c.angle), depth: r2(c.depth) };
      case 'grip':
        return { type: 'grip', ...at, length: r2(c.w), width: r2(c.h), angle: r2(c.angle), depth: r2(c.depth) };
      case 'text':
        return {
          type: 'text',
          ...at,
          text: c.text ?? '',
          font: c.font ?? 'roboto',
          height: r2(c.h),
          angle: r2(c.angle),
          finish: c.relief ?? 'inlay',
        };
    }
  });
  const file = {
    format: FILE_FORMAT,
    version: FILE_VERSION,
    unit: 'mm',
    sheet: { width: 210, height: 297 },
    settings: p.settings,
    contours: p.contours.map((c) => ({ depth: c.depth === null ? null : r2(c.depth), points: c.points.map(([x, y]) => [r2(x), r2(y)]) })),
    cutouts,
    // Last, so the readable part comes first.
    photo: p.photo,
  };
  return JSON.stringify(file, null, 1);
}

// ---------- Reading ----------

class FormatError extends Error {}

const fail = (message: string): never => {
  throw new FormatError(message);
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function num(v: unknown, what: string, min: number, max: number, fallback?: number): number {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) return fail(`${what}: Zahl erwartet.`);
  return Math.min(max, Math.max(min, v));
}

function grid(v: unknown, what: string, max: number): GridValue {
  if (v === undefined || v === 'auto') return 'auto';
  return Math.round(num(v, what, 1, max));
}

const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

// Throws an Error with a German message if the file is unusable.
export function parseProject(text: string): Project {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return fail('Die Datei ist kein gültiges JSON.');
  }
  if (!isObj(data) || data.format !== FILE_FORMAT) return fail('Das ist keine Gridfinity-Kontur-Datei.');
  const version = num(data.version, 'version', 0, Infinity);
  if (version > FILE_VERSION) return fail(`Die Datei stammt aus einer neueren Version (${version}) und kann nicht gelesen werden.`);
  if (data.unit !== undefined && data.unit !== 'mm') return fail('Nur die Einheit „mm“ wird unterstützt.');

  const s = isObj(data.settings) ? data.settings : {};
  const g = isObj(s.grid) ? s.grid : {};
  const c = isObj(s.colors) ? s.colors : {};
  const color = (v: unknown, fallback: string) => (typeof v === 'string' && COLOR_PATTERN.test(v) ? v : fallback);
  const settings: ProjectSettings = {
    clearance: num(s.clearance, 'settings.clearance', 0, 5, 1),
    depth: num(s.depth, 'settings.depth', 1, 160, 15),
    rotation: num(s.rotation, 'settings.rotation', -180, 180, 0),
    grid: { x: grid(g.x, 'settings.grid.x', 10), y: grid(g.y, 'settings.grid.y', 10), z: grid(g.z, 'settings.grid.z', 25) },
    lip: bool(s.lip, true),
    magnets: bool(s.magnets, false),
    colorFloor: bool(s.colorFloor, false),
    sensitivity: num(s.sensitivity, 'settings.sensitivity', 0, 100, 50),
    colors: { body: color(c.body, '#9aa3ad'), accent: color(c.accent, '#f28c28') },
  };

  const rawContours = Array.isArray(data.contours) ? data.contours : [];
  if (rawContours.length > MAX_CONTOURS) fail(`Höchstens ${MAX_CONTOURS} Konturen.`);
  const contours: Contour[] = rawContours.map((rc, i) => {
    const what = `contours[${i}]`;
    if (!isObj(rc) || !Array.isArray(rc.points)) return fail(`${what}: Punkte fehlen.`);
    if (rc.points.length < 3 || rc.points.length > MAX_POINTS) fail(`${what}: 3 bis ${MAX_POINTS} Punkte erwartet.`);
    const points = rc.points.map((p, k): Pt => {
      if (!Array.isArray(p) || p.length !== 2) return fail(`${what}.points[${k}]: [x, y] erwartet.`);
      return [num(p[0], `${what}.points[${k}]`, -1000, 1000), num(p[1], `${what}.points[${k}]`, -1000, 1000)];
    });
    const depth = rc.depth === null || rc.depth === undefined ? null : num(rc.depth, `${what}.depth`, 1, 160);
    return { id: crypto.randomUUID(), points, depth };
  });

  const rawCutouts = Array.isArray(data.cutouts) ? data.cutouts : [];
  if (rawCutouts.length > MAX_CUTOUTS) fail(`Höchstens ${MAX_CUTOUTS} Ausschnitte.`);
  const cutouts: Cutout[] = rawCutouts.map((rc, i) => {
    const what = `cutouts[${i}]`;
    if (!isObj(rc)) return fail(`${what}: Objekt erwartet.`);
    const base = {
      id: crypto.randomUUID(),
      x: num(rc.x, `${what}.x`, -1000, 1000),
      y: num(rc.y, `${what}.y`, -1000, 1000),
      angle: num(rc.angle, `${what}.angle`, -180, 180, 0),
    };
    const size = (v: unknown, name: string) => num(v, `${what}.${name}`, 1, 500);
    const depth = () => num(rc.depth, `${what}.depth`, 1, 160, settings.depth);
    switch (rc.type) {
      case 'circle': {
        const d = size(rc.diameter, 'diameter');
        return { ...base, kind: 'circle', w: d, h: d, angle: 0, depth: depth() };
      }
      case 'rect':
        return { ...base, kind: 'rect', w: size(rc.width, 'width'), h: size(rc.height, 'height'), depth: depth() };
      case 'grip':
        return { ...base, kind: 'grip', w: size(rc.length, 'length'), h: size(rc.width, 'width'), depth: depth() };
      case 'text': {
        if (typeof rc.text !== 'string') return fail(`${what}.text: Text erwartet.`);
        const h = size(rc.height, 'height');
        return {
          ...base,
          kind: 'text',
          // The width follows from the text once the font is loaded.
          w: h,
          h,
          depth: 0,
          text: rc.text.slice(0, MAX_TEXT),
          font: typeof rc.font === 'string' && FONTS.includes(rc.font) ? rc.font : 'roboto',
          relief: rc.finish === 'engraved' ? 'engraved' : 'inlay',
        };
      }
      default:
        return fail(`${what}.type: „rect“, „circle“, „grip“ oder „text“ erwartet.`);
    }
  });

  let photo: string | null = null;
  if (data.photo !== undefined && data.photo !== null) {
    if (typeof data.photo !== 'string' || data.photo.length > MAX_PHOTO || !PHOTO_PATTERN.test(data.photo)) {
      fail('photo: PNG-, JPEG- oder WebP-Bild als Data-URL erwartet.');
    }
    photo = data.photo as string;
  }

  if (!contours.length && !cutouts.length) fail('Die Datei enthält weder Konturen noch Ausschnitte.');
  return { photo, settings, contours, cutouts };
}
