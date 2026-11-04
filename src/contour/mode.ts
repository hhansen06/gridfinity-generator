import type { ManifoldToplevel, Vec2 } from 'manifold-3d';
import { collectGarbage } from '../geometry/gc';
import {
  buildBin,
  CLEARANCE,
  GRID,
  HEIGHT_UNIT,
  INSERT_MIN_FLOOR,
  insertInset,
  type BinResult,
  type InsertCutout,
} from '../geometry/gridfinity';
import { textToShape } from '../geometry/text';
import { loadFont } from '../fonts';
import { detectObjects, findPaper, loadPhoto, PAPER, rectify, type Photo, type Pt } from './detect';
import { ContourEditor, type Overlay } from './editor';
import { FILE_EXTENSION, parseProject, serializeProject, type GridValue, type Project } from './fileformat';
import {
  bestRotation,
  cellsFor,
  fitPoints,
  local,
  makeLayout,
  shapeCenter,
  type Contour,
  type Cutout,
  type CutoutKind,
  type Layout,
} from './layout';

const STATE_KEY = 'gridfinity-contour-v1';
const IMAGE_KEY = 'gridfinity-contour-image-v1';
const MAX_X = 10;
const MAX_Z = 25;

const KIND_NAMES: Record<CutoutKind, string> = { rect: 'Rechteck', circle: 'Kreis', grip: 'Fingergriff', text: 'Text' };
const KIND_ICONS: Record<CutoutKind, string> = {
  rect: '<rect x="4" y="6" width="16" height="12" />',
  circle: '<circle cx="12" cy="12" r="8" />',
  grip: '<rect x="2" y="8" width="20" height="8" rx="4" />',
  text: '<path d="M5 6h14M12 6v13" />',
};
// Field label per kind for w, h; null hides the field.
const FIELD_LABELS: Record<Exclude<CutoutKind, 'text'>, [string, string | null]> = {
  rect: ['Breite', 'Höhe'],
  circle: ['Durchmesser', null],
  grip: ['Länge', 'Breite'],
};
const FONTS: [string, string][] = [
  ['roboto', 'Roboto Bold'],
  ['roboto-slab', 'Roboto Slab'],
  ['roboto-mono', 'Roboto Mono'],
  ['bebas', 'Bebas Neue'],
];
const escapeHtml = (s: string) =>
  s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

export interface ContourForm {
  lip: boolean;
  magnets: boolean;
}

interface ContourFields {
  sensitivity: number;
  colorFloor: boolean;
  offset: number;
  depth: number;
  rotation: number;
  cx: number | null;
  cy: number | null;
  cz: number | null;
}

export interface ContourBuild {
  result: BinResult;
  x: number;
  y: number;
  z: number;
  notes: string[];
}

// Copies are placed this far right and down of the original.
const DUPLICATE_SHIFT = 10;

interface Plan {
  pockets: { polygons: Pt[][]; depth: number }[];
  layout: Layout;
  x: number;
  y: number;
  z: number;
  auto: { x: number; y: number; z: number };
  overlay: Overlay;
}

interface Context {
  form: HTMLFormElement;
  wasm(): ManifoldToplevel | null;
  // Re-runs readouts and (debounced) the geometry.
  schedule(): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const num = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });

export function setupContour(ctx: Context) {
  const { form } = ctx;
  const photoInput = $<HTMLInputElement>('photo-input');
  const photoName = $('photo-name');
  const photoError = $('photo-error');
  const photoTools = $('photo-tools');
  const paperAdjust = $<HTMLButtonElement>('paper-adjust');
  const cutoutList = $<HTMLUListElement>('cutout-list');
  const cutoutFields = $('cutout-fields');
  const contourList = $<HTMLUListElement>('contour-list');
  const contourFields = $('contour-fields');
  const field = <T extends HTMLInputElement | HTMLSelectElement>(name: string) => form.elements.namedItem(name) as T;

  let image: string | null = null;
  // Started without a photo: a blank sheet to place cutouts and texts on.
  let blank = false;
  let contours: Contour[] = [];
  let cutouts: Cutout[] = [];
  let photo: Photo | null = null;
  let corners: Pt[] | null = null;
  let rectified: ImageData | null = null;

  const editor = new ContourEditor($('editor-svg') as unknown as SVGSVGElement, $('editor-bar'), $('editor-empty'), {
    change(final) {
      syncFields();
      if (final) renderLists();
      ctx.schedule();
    },
    select() {
      renderLists();
    },
  });

  // ---------- Form ----------

  for (const [name, max] of [['cx', MAX_X], ['cy', MAX_X], ['cz', MAX_Z]] as const) {
    const select = field<HTMLSelectElement>(name);
    select.innerHTML =
      '<option value="auto">Auto</option>' +
      Array.from({ length: max }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
  }

  function readFields(): ContourFields {
    const data = new FormData(form);
    const n = (name: string, fallback: number) => {
      const v = Number(data.get(name));
      return Number.isFinite(v) ? v : fallback;
    };
    const units = (name: string) => (data.get(name) === 'auto' ? null : n(name, 1));
    return {
      sensitivity: n('sensitivity', 50),
      colorFloor: data.has('colorFloor'),
      offset: Math.max(0, n('offset', 1)),
      depth: Math.max(1, n('pocketDepth', 15)),
      rotation: n('rotation', 0),
      cx: units('cx'),
      cy: units('cy'),
      cz: units('cz'),
    };
  }

  // Cutouts that remove material (texts only touch the surface).
  const cuts = () => cutouts.filter((c) => c.kind !== 'text');

  // ---------- Planning ----------

  function plan(m: ManifoldToplevel, f: ContourFields, lip: boolean): Plan {
    const pockets: Plan['pockets'] = [];
    try {
      for (const c of contours) {
        const cs = m.CrossSection.ofPolygons([c.points], 'NonZero');
        const polygons = (f.offset > 0 ? cs.offset(f.offset, 'Round', 2, 48) : cs).toPolygons() as Pt[][];
        pockets.push({ polygons, depth: c.depth ?? f.depth });
      }
    } finally {
      collectGarbage();
    }
    const pocket = pockets.flatMap((p) => p.polygons);
    const inset = insertInset(lip);
    const layout = makeLayout(fitPoints(pocket, cutouts), f.rotation);
    const deepest = Math.max(1, ...pockets.map((p) => p.depth), ...cuts().map((c) => c.depth));
    const auto = {
      x: Math.min(MAX_X, cellsFor(layout.extent[0], inset)),
      y: Math.min(MAX_X, cellsFor(layout.extent[1], inset)),
      z: Math.min(MAX_Z, Math.max(2, Math.ceil((deepest + INSERT_MIN_FLOOR) / HEIGHT_UNIT))),
    };
    const x = f.cx ?? auto.x;
    const y = f.cy ?? auto.y;
    const z = f.cz ?? auto.z;
    const rect = (inset: number): Pt[] => {
      const w = x * GRID - CLEARANCE - 2 * inset;
      const d = y * GRID - CLEARANCE - 2 * inset;
      return ([[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]] as Vec2[]).map(layout.toPaper);
    };
    return { pockets, layout, x, y, z, auto, overlay: { pocket, bin: rect(0), inner: rect(inset) } };
  }

  function updateReadouts(s: ContourForm): void {
    const f = readFields();
    $('sensitivity-out').textContent = String(f.sensitivity);
    $('offset-out').textContent = num.format(f.offset);
    const m = ctx.wasm();
    if (!m || (!contours.length && !cutouts.length)) {
      editor.setOverlay(null);
      return;
    }
    const p = plan(m, f, s.lip);
    editor.setOverlay(p.overlay);
    for (const [name, key] of [['cx', 'x'], ['cy', 'y'], ['cz', 'z']] as const) {
      const select = field<HTMLSelectElement>(name);
      select.options[0].textContent = `Auto (${p.auto[key]})`;
    }
    const set = (key: string, value: number) => {
      const el = form.querySelector<HTMLElement>(`[data-mm="${key}"]`);
      if (el) el.textContent = `${num.format(value)} mm`;
    };
    set('cx', p.x * GRID - CLEARANCE);
    set('cy', p.y * GRID - CLEARANCE);
    set('cz', p.z * HEIGHT_UNIT);
  }

  async function build(m: ManifoldToplevel, s: ContourForm): Promise<ContourBuild | null> {
    if (!contours.length && !cutouts.length) return null;
    const f = readFields();
    const p = plan(m, f, s.lip);
    const angle = (c: Cutout) => p.layout.rotation - c.angle;
    const insertCutouts: InsertCutout[] = cutouts.flatMap((c) => {
      if (c.kind === 'text') return [];
      const [x, y] = p.layout.toBin([c.x, c.y]);
      return [{ kind: c.kind, x, y, w: c.w, h: c.kind === 'circle' ? c.w : c.h, angle: angle(c), depth: c.depth }];
    });
    const texts = cutouts.flatMap((c) =>
      c.kind === 'text' && c.glyphs?.length
        ? [{
            polygons: c.glyphs.map((poly) => poly.map(([x, y]) => p.layout.toBin(local(c, [x * c.h, y * c.h])))),
            relief: c.relief ?? 'engraved',
          }]
        : [],
    );
    const notes: string[] = [];
    if (p.x < p.auto.x || p.y < p.auto.y) notes.push('Die Aussparung passt nicht ganz in die Box und wird abgeschnitten.');
    const maxDepth = p.z * HEIGHT_UNIT - INSERT_MIN_FLOOR;
    if (Math.max(0, ...p.pockets.map((q) => q.depth), ...cuts().map((c) => c.depth)) > maxDepth) {
      notes.push(`Tiefe auf ${num.format(maxDepth)} mm begrenzt (Box zu niedrig).`);
    }
    const bottomText = textToShape(await loadFont('roboto'), `${p.x}×${p.y}×${p.z}`, 'left');
    try {
      const result = buildBin(m, {
        x: p.x,
        y: p.y,
        z: p.z,
        lip: s.lip,
        magnets: s.magnets,
        label: null,
        bottomText,
        insert: {
          pockets: p.pockets.map((q) => ({ polygons: q.polygons.map((poly) => poly.map(p.layout.toBin)), depth: q.depth })),
          cutouts: insertCutouts,
          texts,
          colorFloor: f.colorFloor,
        },
      });
      saveState();
      return { result, x: p.x, y: p.y, z: p.z, notes };
    } finally {
      collectGarbage();
    }
  }

  // ---------- Photo ----------

  function showError(message: string | null) {
    photoError.hidden = !message;
    photoError.textContent = message ?? '';
  }

  async function setPhoto(file: File) {
    showError(null);
    try {
      photo = await loadPhoto(file);
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
      return;
    }
    photoName.textContent = file.name;
    photoName.classList.remove('muted');
    const found = findPaper(photo.data);
    if (found) {
      corners = found;
      applyCorners(true);
    } else {
      const { width: w, height: h } = photo.data;
      corners = [[w * 0.2, h * 0.1], [w * 0.8, h * 0.1], [w * 0.8, h * 0.9], [w * 0.2, h * 0.9]];
      showError('Das Blatt wurde nicht sicher erkannt. Bitte die Ecken von Hand setzen.');
      adjustPaper();
    }
  }

  function applyCorners(fresh: boolean) {
    if (!photo || !corners) return;
    rectified = rectify(photo.data, corners);
    const canvas = document.createElement('canvas');
    canvas.width = rectified.width;
    canvas.height = rectified.height;
    canvas.getContext('2d')!.putImageData(rectified, 0, 0);
    image = canvas.toDataURL('image/jpeg', 0.85);
    try {
      localStorage.setItem(IMAGE_KEY, image);
    } catch {
      // Too large or storage disabled: works for this session.
    }
    blank = false;
    detect(fresh);
  }

  function adjustPaper() {
    if (!photo || !corners) return;
    const url = photo.canvas.toDataURL('image/jpeg', 0.85);
    editor.showPaper(url, [photo.data.width, photo.data.height], corners, (result) => {
      if (result) {
        corners = result;
        showError(null);
        applyCorners(false);
      } else if (image || blank) {
        editor.showContour(image, contours, cutouts);
      } else {
        editor.showEmpty();
      }
      updateTools();
    });
    updateTools();
  }

  async function redetect() {
    if (!image) return;
    if (!rectified) rectified = await imageData(image);
    detect(false);
  }

  function startBlank() {
    blank = true;
    showError(null);
    editor.showContour(image, contours, cutouts);
    updateTools();
    renderLists();
    ctx.schedule();
  }

  function detect(autoRotate: boolean) {
    if (!rectified || !image) return;
    const found = detectObjects(rectified, readFields().sensitivity);
    if (found.length) {
      showError(null);
      contours = found.map((points) => ({ id: crypto.randomUUID(), points, depth: null }));
    } else {
      showError('Kein Gegenstand erkannt. Empfindlichkeit erhöhen oder die Kontur von Hand ziehen.');
      contours = [manualContour()];
    }
    editor.showContour(image, contours, cutouts);
    // A single part is ready to edit right away.
    editor.select(contours.length === 1 ? contours[0].id : null);
    if (autoRotate) autoRotation();
    renderLists();
    updateTools();
    ctx.schedule();
  }

  function autoRotation() {
    const m = ctx.wasm();
    if (!m || (!contours.length && !cutouts.length)) return;
    const lip = field<HTMLInputElement>('lip').checked;
    const f = { ...readFields(), rotation: 0 };
    const pts = fitPoints(plan(m, f, lip).overlay.pocket, cutouts);
    field<HTMLInputElement>('rotation').value = String(bestRotation(pts, insertInset(lip)));
  }

  function updateTools() {
    photoTools.hidden = !image || editor.isPaper;
    $('contour-section').hidden = !image && !blank;
    paperAdjust.hidden = !photo;
    $('photo-clear').hidden = !image;
    $('contour-reset').hidden = !image && !blank;
  }

  function forgetPhoto() {
    image = null;
    photo = null;
    corners = null;
    rectified = null;
    photoName.textContent = 'Gegenstand auf DIN A4';
    photoName.classList.add('muted');
    showError(null);
    try {
      localStorage.removeItem(IMAGE_KEY);
    } catch {
      // Storage is optional.
    }
  }

  // Keeps contours and cutouts on a blank sheet.
  function removePhoto() {
    forgetPhoto();
    if (contours.length || cutouts.length) {
      startBlank();
    } else {
      reset();
    }
  }

  function reset() {
    forgetPhoto();
    blank = false;
    contours = [];
    cutouts = [];
    editor.select(null);
    editor.showEmpty();
    try {
      localStorage.removeItem(STATE_KEY);
    } catch {
      // Storage is optional.
    }
    renderLists();
    updateTools();
    ctx.schedule();
  }

  // ---------- Cutouts ----------

  function addCutout(kind: CutoutKind) {
    if (!image && !blank) startBlank();
    // Next to the selected contour, or all of them, or on the middle of the sheet.
    const shape = contours.find((c) => c.id === editor.selected);
    const pts = shape ? shape.points : contours.flatMap((c) => c.points);
    if (!pts.length) pts.push([PAPER[0] / 2, PAPER[1] / 2]);
    const [cx, cy] = shapeCenter(pts);
    const depth = shape?.depth ?? readFields().depth;
    const id = crypto.randomUUID();
    const base = { id, kind, angle: 0, depth };
    // Grips start straddling the rightmost point of the part.
    const right = pts.reduce((a, p) => (p[0] > a[0] ? p : a));
    const c: Cutout =
      kind === 'grip'
        ? { ...base, x: Math.round(right[0]), y: Math.round(right[1]), w: 30, h: 20 }
        : kind === 'text'
          ? { ...base, x: Math.round(cx), y: Math.round(cy), w: 20, h: 6, depth: 0, text: 'Text', font: 'roboto', relief: 'inlay' }
          : { ...base, x: Math.round(cx), y: Math.round(cy), w: 20, h: 20 };
    cutouts.push(c);
    if (kind === 'text') updateGlyphs();
    editor.select(id);
    renderLists();
    ctx.schedule();
  }

  // ---------- Contours ----------

  function manualContour(): Contour {
    const [cx, cy] = [PAPER[0] / 2, PAPER[1] / 2];
    return { id: crypto.randomUUID(), points: [[cx - 30, cy - 20], [cx + 30, cy - 20], [cx + 30, cy + 20], [cx - 30, cy + 20]], depth: null };
  }

  const contourSize = (c: Contour) => {
    const xs = c.points.map((p) => p[0]);
    const ys = c.points.map((p) => p[1]);
    return `${num.format(Math.max(...xs) - Math.min(...xs))} × ${num.format(Math.max(...ys) - Math.min(...ys))} mm`;
  };

  function renderContours() {
    contourList.innerHTML = contours
      .map(
        (c, i) => `<li data-id="${c.id}"${c.id === editor.selected ? ' class="selected"' : ''}>
          <button type="button" class="entry" data-action="select">
            <span class="plate-name">${i + 1}</span>
            <span class="entry-text">Kontur ${i + 1}${c.depth !== null ? `<small>${num.format(c.depth)} mm tief</small>` : ''}</span>
            <span class="entry-size">${contourSize(c)}</span>
          </button>
          <button type="button" class="icon" data-action="duplicate" title="Duplizieren">⧉</button>
          <button type="button" class="icon" data-action="remove" title="Entfernen">✕</button>
        </li>`,
      )
      .join('');
    $('contour-count').textContent = contours.length > 1 ? String(contours.length) : '';
    const c = contours.find((c) => c.id === editor.selected);
    contourFields.hidden = !c;
    if (!c) return;
    contourFields.innerHTML = `
      <label class="field"><span>Eigene Tiefe (mm)</span><input type="number" data-contour="depth" min="1" max="160" step="0.5" value="${c.depth ?? ''}" placeholder="${num.format(readFields().depth)} (wie oben)" /></label>
      <div class="field"><span>Drehen</span><span class="inline"><button type="button" class="ghost" data-turn="-90" title="90° gegen den Uhrzeigersinn">↺ 90°</button><button type="button" class="ghost" data-turn="90" title="90° im Uhrzeigersinn">↻ 90°</button></span></div>`;
  }

  function turnContour(c: Contour, degrees: number) {
    const [cx, cy] = shapeCenter(c.points);
    const a = (degrees * Math.PI) / 180;
    const [cos, sin] = [Math.cos(a), Math.sin(a)];
    c.points = c.points.map(([x, y]): Pt => [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos]);
  }

  contourList.addEventListener('click', (e) => {
    const button = (e.target as Element).closest<HTMLButtonElement>('button[data-action]');
    const id = button?.closest('li')?.dataset.id;
    const index = contours.findIndex((c) => c.id === id);
    if (!button || index < 0) return;
    const action = button.dataset.action;
    if (action === 'remove') {
      contours.splice(index, 1);
      if (editor.selected === id) editor.select(null);
    } else if (action === 'duplicate') {
      const src = contours[index];
      const copy: Contour = {
        id: crypto.randomUUID(),
        points: src.points.map(([x, y]): Pt => [x + DUPLICATE_SHIFT, y + DUPLICATE_SHIFT]),
        depth: src.depth,
      };
      contours.splice(index + 1, 0, copy);
      editor.select(copy.id);
    } else {
      editor.select(id!);
    }
    editor.refresh();
    renderLists();
    if (action !== 'select') ctx.schedule();
  });

  contourFields.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    const c = contours.find((c) => c.id === editor.selected);
    if (!c || el.dataset.contour !== 'depth') return;
    const v = Number(el.value);
    c.depth = el.value === '' || !Number.isFinite(v) ? null : Math.max(1, v);
    const small = contourList.querySelector(`li[data-id="${c.id}"] .entry-text`);
    if (small) small.innerHTML = `Kontur ${contours.indexOf(c) + 1}${c.depth !== null ? `<small>${num.format(c.depth)} mm tief</small>` : ''}`;
  });

  contourFields.addEventListener('click', (e) => {
    const turn = (e.target as Element).closest<HTMLElement>('[data-turn]')?.dataset.turn;
    const c = contours.find((c) => c.id === editor.selected);
    if (!turn || !c) return;
    turnContour(c, Number(turn));
    editor.refresh();
    renderLists();
    ctx.schedule();
  });

  $('contour-add').addEventListener('click', () => {
    if (!image && !blank) return;
    const c = manualContour();
    contours.push(c);
    editor.select(c.id);
    renderLists();
    ctx.schedule();
  });

  function renderLists() {
    renderContours();
    renderCutouts();
  }

  function renderCutouts() {
    cutoutList.innerHTML = cutouts
      .map((c) => {
        const name = c.kind === 'text' ? `„${escapeHtml((c.text ?? '').replace(/\n/g, ' '))}“` : KIND_NAMES[c.kind];
        return `<li data-id="${c.id}"${c.id === editor.selected ? ' class="selected"' : ''}>
          <button type="button" class="entry" data-action="select">
            <svg class="cut-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${KIND_ICONS[c.kind]}</svg>
            <span class="entry-text">${name}</span>
            <span class="entry-size">${cutoutSize(c)}</span>
          </button>
          <button type="button" class="icon" data-action="duplicate" title="Duplizieren">⧉</button>
          <button type="button" class="icon" data-action="remove" title="Entfernen">✕</button>
        </li>`;
      })
      .join('');
    const c = cutouts.find((c) => c.id === editor.selected);
    cutoutFields.hidden = !c;
    if (!c) return;
    const input = (key: keyof Cutout, label: string, min: number, max: number, step: number) =>
      `<label class="field"><span>${label}</span><input type="number" data-field="${key}" min="${min}" max="${max}" step="${step}" value="${c[key]}" /></label>`;
    const angle = input('angle', 'Winkel (°)', -180, 180, 1);
    if (c.kind === 'text') {
      const options = (list: [string, string][], value: string | undefined) =>
        list.map(([v, l]) => `<option value="${v}"${v === value ? ' selected' : ''}>${l}</option>`).join('');
      cutoutFields.innerHTML =
        `<label class="field wide"><span>Text</span><textarea data-field="text" rows="2">${escapeHtml(c.text ?? '')}</textarea></label>` +
        `<label class="field"><span>Schriftart</span><select data-field="font">${options(FONTS, c.font)}</select></label>` +
        input('h', 'Höhe (mm)', 2, 100, 0.5) +
        `<label class="field"><span>Ausführung</span><select data-field="relief">${options([['inlay', 'Eingelegt (Farbe)'], ['engraved', 'Graviert']], c.relief)}</select></label>` +
        angle;
      return;
    }
    const [wLabel, hLabel] = FIELD_LABELS[c.kind];
    cutoutFields.innerHTML =
      input('w', `${wLabel} (mm)`, 2, 300, 0.5) +
      (hLabel ? input('h', `${hLabel} (mm)`, 2, 300, 0.5) : '') +
      input('depth', 'Tiefe (mm)', 1, 160, 0.5) +
      (c.kind !== 'circle' ? angle : '');
  }

  function cutoutSize(c: Cutout) {
    if (c.kind === 'circle') return `Ø ${num.format(c.w)} mm`;
    if (c.kind === 'text') return `${num.format(c.h)} mm hoch`;
    return `${num.format(c.w)} × ${num.format(c.h)} mm`;
  }

  // ---------- Texts ----------

  const glyphCache = new Map<string, Promise<{ polygons: Pt[][]; aspect: number }>>();

  function glyphsFor(font: string, text: string) {
    const key = `${font}\u0000${text}`;
    let entry = glyphCache.get(key);
    if (!entry) {
      entry = loadFont(font).then((f) => {
        const shape = text.trim() ? textToShape(f, text, 'center') : null;
        const polygons = (shape?.parts[0].polygons ?? []) as Pt[][];
        const all = polygons.flat();
        if (!all.length) return { polygons: [], aspect: 1 };
        const xs = all.map((p) => p[0]);
        const ys = all.map((p) => p[1]);
        const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
        const h = y1 - y0 || 1;
        // Font y points up, paper y down.
        const norm = polygons.map((poly) =>
          poly.map(([x, y]): Pt => [(x - (x0 + x1) / 2) / h, -(y - (y0 + y1) / 2) / h]),
        );
        return { polygons: norm, aspect: (x1 - x0) / h };
      });
      if (glyphCache.size > 50) glyphCache.clear();
      glyphCache.set(key, entry);
    }
    return entry;
  }

  // Fills in outlines and widths of texts whose content or font changed.
  async function updateGlyphs() {
    let changed = false;
    for (const c of cutouts) {
      if (c.kind !== 'text') continue;
      const want = `${c.font}\u0000${c.text}`;
      if (c.glyphKey === want) continue;
      const g = await glyphsFor(c.font ?? 'roboto', c.text ?? '');
      c.glyphs = g.polygons;
      c.w = Math.max(1, Math.round(c.h * g.aspect * 100) / 100);
      c.glyphKey = want;
      changed = true;
    }
    if (changed) {
      editor.refresh();
      syncFields();
      ctx.schedule();
    }
  }

  // Keeps the numeric fields in step while a cutout is dragged.
  function syncFields() {
    const c = cutouts.find((c) => c.id === editor.selected);
    if (!c) return;
    for (const el of cutoutFields.querySelectorAll<HTMLInputElement>('input[type="number"][data-field]')) {
      if (el !== document.activeElement) el.value = String(c[el.dataset.field as 'w' | 'h' | 'depth' | 'angle']);
    }
  }

  const onCutoutField = (e: Event) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    const c = cutouts.find((c) => c.id === editor.selected);
    const key = el.dataset.field;
    if (!c || !key) return;
    if (key === 'text' || key === 'font') {
      c[key] = el.value;
      const name = cutoutList.querySelector(`li[data-id="${c.id}"] .entry-text`);
      if (name && key === 'text') name.textContent = `„${c.text!.replace(/\n/g, ' ')}“`;
      updateGlyphs();
      return;
    }
    if (key === 'relief') {
      c.relief = el.value as Cutout['relief'];
      return;
    }
    const v = Number(el.value);
    if (el.value === '' || !Number.isFinite(v)) return;
    const k = key as 'w' | 'h' | 'depth' | 'angle';
    if (c.kind === 'text' && k === 'h') c.w = (c.w * Math.max(2, v)) / c.h;
    c[k] = k === 'angle' ? v : Math.max(k === 'depth' ? 1 : 2, v);
    if (c.kind === 'circle' && k === 'w') c.h = c.w;
    editor.refresh();
    const size = cutoutList.querySelector(`li[data-id="${c.id}"] .entry-size`);
    if (size) size.textContent = cutoutSize(c);
  };
  cutoutFields.addEventListener('input', onCutoutField);
  cutoutFields.addEventListener('change', onCutoutField);

  cutoutList.addEventListener('click', (e) => {
    const button = (e.target as Element).closest<HTMLButtonElement>('button[data-action]');
    const id = button?.closest('li')?.dataset.id;
    if (!button || !id) return;
    if (button.dataset.action === 'remove') {
      cutouts.splice(cutouts.findIndex((c) => c.id === id), 1);
      editor.select(editor.selected === id ? null : editor.selected);
      ctx.schedule();
    } else if (button.dataset.action === 'duplicate') {
      const index = cutouts.findIndex((c) => c.id === id);
      const copy = { ...cutouts[index], id: crypto.randomUUID() };
      copy.x += DUPLICATE_SHIFT;
      copy.y += DUPLICATE_SHIFT;
      cutouts.splice(index + 1, 0, copy);
      editor.select(copy.id);
      ctx.schedule();
    } else {
      editor.select(id);
    }
    renderLists();
  });

  for (const button of form.querySelectorAll<HTMLButtonElement>('[data-add]')) {
    button.addEventListener('click', () => addCutout(button.dataset.add as CutoutKind));
  }

  // ---------- Wiring ----------

  const pick = () => photoInput.click();
  $('photo-pick').addEventListener('click', pick);
  $('photo-pick-2').addEventListener('click', pick);
  $('start-blank').addEventListener('click', startBlank);
  photoInput.addEventListener('change', () => {
    const file = photoInput.files?.[0];
    if (file) setPhoto(file);
    photoInput.value = '';
  });
  for (const zone of [$('photo-drop'), $('editor-empty')]) {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      const file = e.dataTransfer?.files[0];
      if (file) {
        if (isProjectFile(file)) openProject(file);
        else setPhoto(file);
      }
    });
  }
  $('contour-redetect').addEventListener('click', () => redetect());
  field<HTMLInputElement>('sensitivity').addEventListener('change', () => redetect());
  paperAdjust.addEventListener('click', adjustPaper);
  $('photo-clear').addEventListener('click', removePhoto);
  // Two clicks instead of a confirm() dialog.
  const resetBtn = $<HTMLButtonElement>('contour-reset');
  let armed = 0;
  resetBtn.addEventListener('click', () => {
    if (!armed) {
      resetBtn.textContent = 'Wirklich alles löschen?';
      armed = window.setTimeout(() => {
        armed = 0;
        resetBtn.textContent = 'Alles zurücksetzen';
      }, 3000);
      return;
    }
    clearTimeout(armed);
    armed = 0;
    resetBtn.textContent = 'Alles zurücksetzen';
    reset();
  });
  $('rotation-auto').addEventListener('click', () => {
    autoRotation();
    ctx.schedule();
  });

  // ---------- File ----------

  const projectError = $('project-error');

  function showProjectError(message: string | null) {
    projectError.hidden = !message;
    projectError.textContent = message ?? '';
  }

  function currentProject(withPhoto: boolean): Project {
    const value = (n: string) => field<HTMLInputElement>(n).value;
    const checked = (n: string) => field<HTMLInputElement>(n).checked;
    const gridValue = (n: string): GridValue => (value(n) === 'auto' ? 'auto' : Number(value(n)));
    const f = readFields();
    return {
      photo: withPhoto ? image : null,
      settings: {
        clearance: f.offset,
        depth: f.depth,
        rotation: f.rotation,
        grid: { x: gridValue('cx'), y: gridValue('cy'), z: gridValue('cz') },
        lip: checked('lip'),
        magnets: checked('magnets'),
        colorFloor: f.colorFloor,
        sensitivity: f.sensitivity,
        colors: { body: value('bodyColor'), accent: value('reliefColor') },
      },
      contours,
      cutouts,
    };
  }

  function saveProject() {
    if (!contours.length && !cutouts.length) {
      showProjectError('Es gibt noch nichts zu speichern.');
      return;
    }
    showProjectError(null);
    const withPhoto = $<HTMLInputElement>('project-photo').checked;
    const blob = new Blob([serializeProject(currentProject(withPhoto))], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `kontur_${new Date().toISOString().slice(0, 10)}${FILE_EXTENSION}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function openProject(file: File) {
    let project: Project;
    try {
      if (file.size > 20_000_000) throw new Error('Die Datei ist zu groß.');
      project = parseProject(await file.text());
    } catch (err) {
      showProjectError(err instanceof Error ? err.message : String(err));
      return;
    }
    showProjectError(null);
    showError(null);
    const { settings: st } = project;
    const set = (n: string, v: string) => (field<HTMLInputElement>(n).value = v);
    const check = (n: string, v: boolean) => (field<HTMLInputElement>(n).checked = v);
    set('offset', String(st.clearance));
    set('pocketDepth', String(st.depth));
    set('rotation', String(st.rotation));
    set('cx', String(st.grid.x));
    set('cy', String(st.grid.y));
    set('cz', String(st.grid.z));
    set('sensitivity', String(st.sensitivity));
    set('bodyColor', st.colors.body);
    set('reliefColor', st.colors.accent);
    check('lip', st.lip);
    check('magnets', st.magnets);
    check('colorFloor', st.colorFloor);

    photo = null;
    corners = null;
    rectified = null;
    image = project.photo;
    blank = !image;
    contours = project.contours;
    cutouts = project.cutouts;
    try {
      if (image) localStorage.setItem(IMAGE_KEY, image);
      else localStorage.removeItem(IMAGE_KEY);
    } catch {
      // Storage is optional.
    }
    photoName.textContent = image ? `Foto aus ${file.name}` : 'Gegenstand auf DIN A4';
    photoName.classList.toggle('muted', !image);
    editor.select(null);
    editor.showContour(image, contours, cutouts);
    renderLists();
    updateTools();
    await updateGlyphs();
    ctx.schedule();
  }

  const isProjectFile = (file: File) => file.name.toLowerCase().endsWith(FILE_EXTENSION) || file.type === 'application/json';
  const projectInput = $<HTMLInputElement>('project-input');
  $('project-save').addEventListener('click', saveProject);
  $('project-open').addEventListener('click', () => projectInput.click());
  projectInput.addEventListener('change', () => {
    const file = projectInput.files?.[0];
    if (file) openProject(file);
    projectInput.value = '';
  });

  // ---------- Persistence ----------

  const PERSISTED = ['offset', 'pocketDepth', 'rotation', 'cx', 'cy', 'cz', 'sensitivity'];
  const PERSISTED_CHECKS = ['colorFloor'];

  function saveState() {
    try {
      const values = Object.fromEntries(PERSISTED.map((n) => [n, field<HTMLInputElement>(n).value]));
      const checks = Object.fromEntries(PERSISTED_CHECKS.map((n) => [n, field<HTMLInputElement>(n).checked]));
      // Glyphs are derived from the text and rebuilt on load.
      const plain = cutouts.map(({ glyphs: _g, glyphKey: _k, ...c }) => c);
      localStorage.setItem(STATE_KEY, JSON.stringify({ contours, cutouts: plain, values, checks, blank: blank && !image }));
    } catch {
      // Storage is optional.
    }
  }

  function restore() {
    try {
      const saved = localStorage.getItem(IMAGE_KEY);
      const state = JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null') as {
        contours?: Contour[];
        // Before several contours were supported.
        outline?: Pt[];
        cutouts: Cutout[];
        values: Record<string, string>;
        checks?: Record<string, boolean>;
        blank?: boolean;
      } | null;
      if (!state || (!saved && !state.blank)) return;
      const restored = state.contours ?? (state.outline ? [{ id: crypto.randomUUID(), points: state.outline, depth: null }] : []);
      if (!restored.length && !state.cutouts.length) return;
      image = saved && !state.blank ? saved : null;
      blank = !image;
      contours = restored;
      cutouts = state.cutouts;
      for (const [n, v] of Object.entries(state.values)) {
        const el = field<HTMLInputElement>(n);
        if (el && PERSISTED.includes(n)) el.value = v;
      }
      for (const [n, v] of Object.entries(state.checks ?? {})) {
        const el = field<HTMLInputElement>(n);
        if (el && PERSISTED_CHECKS.includes(n)) el.checked = v;
      }
      if (image) photoName.textContent = 'Foto der letzten Sitzung';
      editor.showContour(image, contours, cutouts);
      renderLists();
      updateTools();
      updateGlyphs();
    } catch {
      // Corrupt storage: start fresh.
    }
  }
  restore();

  return {
    updateReadouts,
    build,
    fileName: (b: Pick<ContourBuild, 'x' | 'y' | 'z'>) => `gridfinity_kontur_${b.x}x${b.y}x${b.z}`,
  };
}

async function imageData(url: string): Promise<ImageData> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
