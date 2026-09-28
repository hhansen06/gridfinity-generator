import { strToU8, zipSync } from 'fflate';
import type { MeshData } from './geometry/gridfinity';

export interface ModelPart {
  name: string;
  mesh: MeshData;
  // Index into the palette passed to toThreeMf.
  color: number;
}

export interface Model3mf {
  name: string;
  parts: ModelPart[];
  // Footprint in mm, used to lay the models out side by side.
  size: [number, number];
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
  <Default Extension="config" ContentType="text/xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

const SPACING = 10;
const COLORS_ID = 1;

const escapeXml = (s: string) =>
  s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

const num = (v: number) => String(Math.round(v * 1e4) / 1e4);

function meshXml({ positions, indices }: MeshData, color: number): string {
  const out: string[] = ['<mesh><vertices>'];
  for (let i = 0; i < positions.length; i += 3) {
    out.push(`<vertex x="${num(positions[i])}" y="${num(positions[i + 1])}" z="${num(positions[i + 2])}"/>`);
  }
  out.push('</vertices><triangles>');
  // Per-triangle color references are what Bambu Studio / OrcaSlicer read.
  for (let i = 0; i < indices.length; i += 3) {
    out.push(`<triangle v1="${indices[i]}" v2="${indices[i + 1]}" v3="${indices[i + 2]}" pid="${COLORS_ID}" p1="${color}"/>`);
  }
  out.push('</triangles></mesh>');
  return out.join('');
}

// Simple shelf packing of the model footprints into rows.
function layout(models: Model3mf[]): [number, number][] {
  const totalArea = models.reduce((a, m) => a + (m.size[0] + SPACING) * (m.size[1] + SPACING), 0);
  const rowWidth = Math.max(Math.sqrt(totalArea), ...models.map((m) => m.size[0]));
  const offsets: [number, number][] = [];
  let x = 0;
  let y = 0;
  let rowDepth = 0;
  for (const m of models) {
    if (x > 0 && x + m.size[0] > rowWidth) {
      x = 0;
      y += rowDepth + SPACING;
      rowDepth = 0;
    }
    offsets.push([x + m.size[0] / 2, y + m.size[1] / 2]);
    x += m.size[0] + SPACING;
    rowDepth = Math.max(rowDepth, m.size[1]);
  }
  return offsets;
}

// Every model becomes one object whose parts are components, so slicers keep
// box and label aligned as one multi-part object with separate colors.
export function toThreeMf(models: Model3mf[], palette: string[]): Blob {
  const resources: string[] = [
    `<m:colorgroup id="${COLORS_ID}">`,
    ...palette.map((c) => `<m:color color="${c.toUpperCase()}FF"/>`),
    '</m:colorgroup>',
  ];
  const items: string[] = [];
  // Bambu Studio / OrcaSlicer read per-part filament assignments from here.
  const settings: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<config>'];
  const offsets = layout(models);
  let nextId = COLORS_ID + 1;

  models.forEach((model, mi) => {
    const partIds = model.parts.map((part) => {
      const id = nextId++;
      resources.push(
        `<object id="${id}" type="model" name="${escapeXml(part.name)}" pid="${COLORS_ID}" pindex="${part.color}">${meshXml(part.mesh, part.color)}</object>`,
      );
      return id;
    });
    const assemblyId = nextId++;
    resources.push(
      `<object id="${assemblyId}" type="model" name="${escapeXml(model.name)}"><components>`,
      ...partIds.map((id) => `<component objectid="${id}"/>`),
      '</components></object>',
    );
    settings.push(`  <object id="${assemblyId}">`, `    <metadata key="name" value="${escapeXml(model.name)}"/>`);
    model.parts.forEach((part, pi) =>
      settings.push(
        `    <part id="${partIds[pi]}" subtype="normal_part">`,
        `      <metadata key="name" value="${escapeXml(part.name)}"/>`,
        `      <metadata key="extruder" value="${part.color + 1}"/>`,
        '    </part>',
      ),
    );
    settings.push('  </object>');
    const [ox, oy] = offsets[mi];
    items.push(`<item objectid="${assemblyId}" transform="1 0 0 0 1 0 0 0 1 ${num(ox)} ${num(oy)} 0"/>`);
  });

  const model = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="de-DE" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">',
    '<metadata name="Application">Gridfinity Generator</metadata>',
    '<resources>',
    ...resources,
    '</resources>',
    '<build>',
    ...items,
    '</build>',
    '</model>',
  ].join('\n');

  const zip = zipSync(
    {
      '[Content_Types].xml': strToU8(CONTENT_TYPES),
      '_rels/.rels': strToU8(RELS),
      '3D/3dmodel.model': strToU8(model),
      'Metadata/model_settings.config': strToU8([...settings, '</config>'].join('\n')),
    },
    { level: 6 },
  );
  return new Blob([zip], { type: 'model/3mf' });
}
