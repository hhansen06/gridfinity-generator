import type { CrossSection, FillRule, Manifold, ManifoldToplevel, Vec2, Vec3 } from 'manifold-3d';

// Dimensions follow the Gridfinity spec by Zack Freedman (all values in mm).
export const GRID = 42;
export const HEIGHT_UNIT = 7;
const CLEARANCE = 0.5;
const OUTER_RADIUS = 3.75;
// Foot profile (0.8 / 1.8 / 2.15) plus the bridge tying the feet together;
// the inner floor sits at BASE_HEIGHT.
const BASE_PROFILE_HEIGHT = 4.75;
const BASE_HEIGHT = 7;
const WALL = 1.2;
// Stacking lip, bottom to top: 0.7 at 45°, 1.8 vertical, 1.9 at 45° (4.4 total,
// 2.6 deep). Below it a 1.2 mm vertical support, then 45° out to the wall.
const LIP_DEPTH = 2.6;
const LIP_SUPPORT = 1.2;
// The spec's knife edge is cut off where the lip is 0.4 mm wide (one line).
// Stacked feet still seat on the chamfers, so this does not change the fit.
const LIP_TIP = 0.4;
const LIP_HEIGHT = 4.4 - LIP_TIP;
const MAGNET_RADIUS = 3.25;
const MAGNET_DEPTH = 2.4;
const MAGNET_OFFSET = 13;
const TAB_THICKNESS = 1.2;
const RELIEF_HEIGHT = 0.5;
const ENGRAVE_DEPTH = 0.6;
const LABEL_MARGIN = 1;
const ICON_GAP = 1.5;
// With text present, icons may take at most this share of the label width.
const ICON_WIDTH_SHARE = 0.5;
const MIN_ICON_HEIGHT = 4;

// Parts are applied in order; 'subtract' parts cut into what came before.
export interface Shape2D {
  parts: { polygons: Vec2[][]; fillRule: FillRule; subtract?: boolean }[];
}

export interface LabelParams {
  depth: number;
  relief: 'raised' | 'engraved' | 'inlay';
  align: 'left' | 'center';
  text: Shape2D | null;
  // Height of one em in mm; the text shrinks if it does not fit.
  textSize: number;
  icons: LabelIcon[];
}

export interface LabelIcon {
  shape: Shape2D;
  // Maximum width relative to the label height.
  aspect: number;
}

export interface BinParams {
  x: number;
  y: number;
  z: number;
  lip: boolean;
  magnets: boolean;
  label: LabelParams | null;
}

export interface MeshData {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface BinResult {
  body: MeshData;
  relief: MeshData | null;
  size: Vec3;
}

export function buildBin(wasm: ManifoldToplevel, p: BinParams): BinResult {
  const { Manifold, CrossSection } = wasm;
  const width = p.x * GRID - CLEARANCE;
  const depth = p.y * GRID - CLEARANCE;
  const height = p.z * HEIGHT_UNIT;
  const top = p.lip ? height + LIP_HEIGHT : height;
  const floorZ = BASE_HEIGHT;

  const roundedRect = (w: number, d: number, r: number): CrossSection => {
    const radius = Math.max(r, 0.05);
    return CrossSection.square([w - 2 * radius, d - 2 * radius], true).offset(radius, 'Round', 2, 48);
  };
  // All footprints share the same core rectangle, so a hull between two of
  // them is an exact 45° chamfer with correctly shrinking corner radii. Hulls
  // must only span one straight segment: the profiles are not convex overall.
  const footprint = (inset: number) => roundedRect(width - 2 * inset, depth - 2 * inset, OUTER_RADIUS - inset);
  const prism = (cs: CrossSection, z0: number, z1: number) => cs.extrude(z1 - z0).translate(0, 0, z0);
  const loft = (levels: [CrossSection, number][]): Manifold =>
    Manifold.hull(levels.flatMap(([cs, z]) => cs.toPolygons().flat().map(([x, y]): Vec3 => [x, y, z])));

  const footWaist = roundedRect(37.2, 37.2, 1.6);
  const foot = Manifold.union([
    loft([[roundedRect(35.6, 35.6, 0.8), 0], [footWaist, 0.8]]),
    prism(footWaist, 0.8, 2.6),
    loft([[footWaist, 2.6], [roundedRect(41.5, 41.5, OUTER_RADIUS), BASE_PROFILE_HEIGHT]]),
  ]);
  let magnetHoles: Manifold | null = null;
  if (p.magnets) {
    const hole = Manifold.cylinder(MAGNET_DEPTH, MAGNET_RADIUS, MAGNET_RADIUS, 32);
    magnetHoles = Manifold.union(
      [-1, 1].flatMap((sx) => [-1, 1].map((sy) => hole.translate(sx * MAGNET_OFFSET, sy * MAGNET_OFFSET, 0))),
    );
  }
  const cellFoot = magnetHoles ? foot.subtract(magnetHoles) : foot;
  const feet: Manifold[] = [];
  for (let i = 0; i < p.x; i++) {
    for (let j = 0; j < p.y; j++) {
      feet.push(cellFoot.translate((i - (p.x - 1) / 2) * GRID, (j - (p.y - 1) / 2) * GRID, 0));
    }
  }

  const cavities: Manifold[] = [];
  if (p.lip) {
    const supportTop = height - LIP_SUPPORT;
    const supportBottom = supportTop - (LIP_DEPTH - WALL);
    // Low bins: the support would start below the floor; the trim below cuts it off.
    if (supportBottom > floorZ) cavities.push(prism(footprint(WALL), floorZ, supportBottom));
    cavities.push(
      loft([[footprint(WALL), supportBottom], [footprint(LIP_DEPTH), supportTop]]),
      prism(footprint(LIP_DEPTH), supportTop, height),
      loft([[footprint(LIP_DEPTH), height], [footprint(1.9), height + 0.7]]),
      prism(footprint(1.9), height + 0.7, height + 2.5),
      // Continue the 45° chamfer past the top so the cut is clean.
      loft([[footprint(1.9), height + 2.5], [footprint(-0.5), height + 4.9]]),
    );
  } else {
    cavities.push(prism(footprint(WALL), floorZ, top + 1));
  }

  let body = Manifold.union([...feet, prism(footprint(0), BASE_PROFILE_HEIGHT, top)]).subtract(
    Manifold.union(cavities).trimByPlane([0, 0, 1], floorZ),
  );

  let relief: Manifold | null = null;
  const label = p.label;
  if (label) {
    // Below the lip so the feet of a stacked bin do not hit the raised label.
    const tabTop = p.lip ? height - 1 : label.relief === 'raised' ? height - RELIEF_HEIGHT : height;
    const tabDepth = Math.min(label.depth, depth - 2 * WALL - 2);
    const back = depth / 2 - WALL;
    const front = back - tabDepth;
    const xEdge = width / 2;
    const profile: [number, number][] = [
      [back + WALL / 2, tabTop],
      [front, tabTop],
      [front, tabTop - TAB_THICKNESS],
      [back + WALL / 2, tabTop - TAB_THICKNESS - tabDepth - WALL / 2],
    ];
    const tab = Manifold.hull(profile.flatMap(([y, z]) => [[-xEdge, y, z] as Vec3, [xEdge, y, z] as Vec3])).intersect(
      prism(footprint(WALL / 2), BASE_HEIGHT, top),
    );
    body = body.add(tab);

    const content = layoutLabel(wasm, label, {
      x0: -width / 2 + WALL + LABEL_MARGIN,
      x1: width / 2 - WALL - LABEL_MARGIN,
      y0: front + LABEL_MARGIN,
      y1: back - LABEL_MARGIN,
    });
    if (content) {
      if (label.relief === 'raised') {
        relief = prism(content, tabTop, tabTop + RELIEF_HEIGHT);
      } else {
        body = body.subtract(prism(content, tabTop - ENGRAVE_DEPTH, tabTop + 0.01));
        // Inlay: a separate part filling the engraving flush, for multi-color prints.
        if (label.relief === 'inlay') relief = prism(content, tabTop - ENGRAVE_DEPTH, tabTop);
      }
    }
  }

  return {
    body: toMeshData(body),
    relief: relief && !relief.isEmpty() ? toMeshData(relief) : null,
    size: [width, depth, top],
  };
}

interface Box2D {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function toCrossSection(wasm: ManifoldToplevel, shape: Shape2D): CrossSection | null {
  let result: CrossSection | null = null;
  for (const part of shape.parts) {
    const cs = wasm.CrossSection.ofPolygons(part.polygons, part.fillRule);
    if (!result) result = part.subtract ? null : cs;
    else result = part.subtract ? result.subtract(cs) : result.add(cs);
  }
  return result;
}

// Uniformly scales the shape into the box, anchored at its left edge and
// centered vertically. Returns null for empty shapes.
function fitInto(cs: CrossSection | null, box: Box2D, maxScale = Infinity): CrossSection | null {
  if (!cs || cs.isEmpty()) return null;
  const b = cs.bounds();
  const w = b.max[0] - b.min[0];
  const h = b.max[1] - b.min[1];
  const scale = Math.min((box.x1 - box.x0) / w, (box.y1 - box.y0) / h, maxScale);
  if (!(scale > 0) || !isFinite(scale)) return null;
  const midY = (box.y0 + box.y1) / 2;
  return cs
    .translate([-b.min[0], -(b.min[1] + b.max[1]) / 2])
    .scale(scale)
    .translate([box.x0, midY]);
}

function layoutLabel(wasm: ManifoldToplevel, label: LabelParams, area: Box2D): CrossSection | null {
  if (area.x1 - area.x0 < 2 || area.y1 - area.y0 < 2) return null;
  const pieces: CrossSection[] = [];
  let cursor = area.x0;

  const areaWidth = area.x1 - area.x0;
  const areaHeight = area.y1 - area.y0;
  const icons = label.icons.flatMap((icon) => {
    const cs = toCrossSection(wasm, icon.shape);
    if (!cs || cs.isEmpty()) return [];
    const b = cs.bounds();
    const ratio = Math.min((b.max[0] - b.min[0]) / (b.max[1] - b.min[1]), icon.aspect);
    return [{ cs, ratio }];
  });

  // Shrink icons on narrow bins so the text keeps enough room.
  const gaps = icons.length * ICON_GAP;
  const ratioSum = icons.reduce((sum, i) => sum + i.ratio, 0);
  const budget = label.text ? areaWidth * ICON_WIDTH_SHARE : areaWidth;
  const iconHeight = Math.min(areaHeight, Math.max(MIN_ICON_HEIGHT, (budget - gaps) / ratioSum));
  const midY = (area.y0 + area.y1) / 2;

  for (const { cs, ratio } of icons) {
    if (cursor >= area.x1 - 1) break;
    const placed = fitInto(cs, {
      x0: cursor,
      x1: Math.min(cursor + iconHeight * ratio, area.x1),
      y0: midY - iconHeight / 2,
      y1: midY + iconHeight / 2,
    });
    if (placed) {
      pieces.push(placed);
      cursor = placed.bounds().max[0] + ICON_GAP;
    }
  }

  if (label.text && cursor < area.x1 - 1) {
    // Text shapes come in at font size 100.
    const text = fitInto(
      toCrossSection(wasm, label.text),
      { x0: cursor, x1: area.x1, y0: area.y0, y1: area.y1 },
      label.textSize / 100,
    );
    if (text) pieces.push(text);
  }

  if (pieces.length === 0) return null;
  let content = wasm.CrossSection.union(pieces);
  if (label.align === 'center') {
    const b = content.bounds();
    content = content.translate([(area.x0 + area.x1) / 2 - (b.min[0] + b.max[0]) / 2, 0]);
  }
  return content;
}

function toMeshData(m: Manifold): MeshData {
  const mesh = m.getMesh();
  const positions = new Float32Array((mesh.vertProperties.length / mesh.numProp) * 3);
  for (let v = 0, n = positions.length / 3; v < n; v++) {
    positions[v * 3] = mesh.vertProperties[v * mesh.numProp];
    positions[v * 3 + 1] = mesh.vertProperties[v * mesh.numProp + 1];
    positions[v * 3 + 2] = mesh.vertProperties[v * mesh.numProp + 2];
  }
  return { positions, indices: new Uint32Array(mesh.triVerts) };
}
