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
import { detectObject, findPaper, loadPhoto, PAPER, rectify, type Photo, type Pt } from './detect';
import { ContourEditor, type Overlay } from './editor';
import { bestRotation, cellsFor, fitPoints, makeLayout, type Cutout, type CutoutKind, type Layout } from './layout';

const STATE_KEY = 'gridfinity-contour-v1';
const IMAGE_KEY = 'gridfinity-contour-image-v1';
const MAX_X = 10;
const MAX_Z = 25;

const KIND_NAMES: Record<CutoutKind, string> = { rect: 'Rechteck', circle: 'Kreis', grip: 'Fingergriff' };
const KIND_ICONS: Record<CutoutKind, string> = {
  rect: '<rect x="4" y="6" width="16" height="12" />',
  circle: '<circle cx="12" cy="12" r="8" />',
  grip: '<rect x="2" y="8" width="20" height="8" rx="4" />',
};
// Field label per kind for w, h; null hides the field.
const FIELD_LABELS: Record<CutoutKind, [string, string | null]> = {
  rect: ['Breite', 'Höhe'],
  circle: ['Durchmesser', null],
  grip: ['Länge', 'Breite'],
};

export interface ContourForm {
  lip: boolean;
  magnets: boolean;
}

interface ContourFields {
  sensitivity: number;
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

interface Plan {
  pocket: Pt[][];
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
  const field = <T extends HTMLInputElement | HTMLSelectElement>(name: string) => form.elements.namedItem(name) as T;

  let image: string | null = null;
  let outline: Pt[] = [];
  let cutouts: Cutout[] = [];
  let photo: Photo | null = null;
  let corners: Pt[] | null = null;
  let rectified: ImageData | null = null;

  const editor = new ContourEditor($('editor-svg') as unknown as SVGSVGElement, $('editor-bar'), $('editor-empty'), {
    change(final) {
      syncFields();
      if (final) renderCutouts();
      ctx.schedule();
    },
    select() {
      renderCutouts();
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
      offset: Math.max(0, n('offset', 1)),
      depth: Math.max(1, n('pocketDepth', 15)),
      rotation: n('rotation', 0),
      cx: units('cx'),
      cy: units('cy'),
      cz: units('cz'),
    };
  }

  // ---------- Planning ----------

  function plan(m: ManifoldToplevel, f: ContourFields, lip: boolean): Plan {
    let pocket: Pt[][] = [];
    try {
      const cs = m.CrossSection.ofPolygons([outline], 'NonZero');
      pocket = (f.offset > 0 ? cs.offset(f.offset, 'Round', 2, 48) : cs).toPolygons() as Pt[][];
    } finally {
      collectGarbage();
    }
    const inset = insertInset(lip);
    const layout = makeLayout(fitPoints(pocket, cutouts), f.rotation);
    const deepest = Math.max(f.depth, ...cutouts.map((c) => c.depth));
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
    return { pocket, layout, x, y, z, auto, overlay: { pocket, bin: rect(0), inner: rect(inset) } };
  }

  function updateReadouts(s: ContourForm): void {
    const f = readFields();
    $('sensitivity-out').textContent = String(f.sensitivity);
    $('offset-out').textContent = num.format(f.offset);
    const m = ctx.wasm();
    if (!m || outline.length < 3) {
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
    if (outline.length < 3) return null;
    const f = readFields();
    const p = plan(m, f, s.lip);
    const angle = (c: Cutout) => p.layout.rotation - c.angle;
    const insertCutouts: InsertCutout[] = cutouts.map((c) => {
      const [x, y] = p.layout.toBin([c.x, c.y]);
      return { kind: c.kind, x, y, w: c.w, h: c.kind === 'circle' ? c.w : c.h, angle: angle(c), depth: c.depth };
    });
    const notes: string[] = [];
    if (p.x < p.auto.x || p.y < p.auto.y) notes.push('Die Aussparung passt nicht ganz in die Box und wird abgeschnitten.');
    const maxDepth = p.z * HEIGHT_UNIT - INSERT_MIN_FLOOR;
    if (Math.max(f.depth, ...cutouts.map((c) => c.depth)) > maxDepth) {
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
        insert: { pocket: p.pocket.map((poly) => poly.map(p.layout.toBin)), depth: f.depth, cutouts: insertCutouts },
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
    if (fresh) cutouts = [];
    detect(true);
  }

  function adjustPaper() {
    if (!photo || !corners) return;
    const url = photo.canvas.toDataURL('image/jpeg', 0.85);
    editor.showPaper(url, [photo.data.width, photo.data.height], corners, (result) => {
      if (result) {
        corners = result;
        showError(null);
        applyCorners(false);
      } else if (image) {
        editor.showContour(image, outline, cutouts);
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

  function detect(autoRotate: boolean) {
    if (!rectified || !image) return;
    const found = detectObject(rectified, readFields().sensitivity);
    if (found) {
      showError(null);
      outline = found;
    } else {
      showError('Kein Gegenstand erkannt. Empfindlichkeit erhöhen oder die Kontur von Hand ziehen.');
      const [cx, cy] = [PAPER[0] / 2, PAPER[1] / 2];
      outline = [[cx - 30, cy - 20], [cx + 30, cy - 20], [cx + 30, cy + 20], [cx - 30, cy + 20]];
    }
    editor.showContour(image, outline, cutouts);
    if (autoRotate) autoRotation();
    renderCutouts();
    updateTools();
    ctx.schedule();
  }

  function autoRotation() {
    const m = ctx.wasm();
    if (!m || outline.length < 3) return;
    const lip = field<HTMLInputElement>('lip').checked;
    const f = { ...readFields(), rotation: 0 };
    const pts = fitPoints(plan(m, f, lip).pocket, cutouts);
    field<HTMLInputElement>('rotation').value = String(bestRotation(pts, insertInset(lip)));
  }

  function updateTools() {
    photoTools.hidden = !image || editor.isPaper;
    paperAdjust.hidden = !photo;
  }

  // ---------- Cutouts ----------

  function addCutout(kind: CutoutKind) {
    if (outline.length < 3) return;
    const xs = outline.map((p) => p[0]);
    const ys = outline.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const depth = readFields().depth;
    const id = crypto.randomUUID();
    const base = { id, kind, angle: 0, depth };
    // Grips start straddling the rightmost point of the part.
    const right = outline.reduce((a, p) => (p[0] > a[0] ? p : a));
    const c: Cutout =
      kind === 'grip'
        ? { ...base, x: Math.round(right[0]), y: Math.round(right[1]), w: 30, h: 20 }
        : { ...base, x: Math.round(cx), y: Math.round(cy), w: 20, h: 20 };
    cutouts.push(c);
    editor.select(id);
    renderCutouts();
    ctx.schedule();
  }

  function renderCutouts() {
    cutoutList.innerHTML = cutouts
      .map((c) => {
        const size = c.kind === 'circle' ? `Ø ${num.format(c.w)}` : `${num.format(c.w)} × ${num.format(c.h)}`;
        return `<li data-id="${c.id}"${c.id === editor.selected ? ' class="selected"' : ''}>
          <button type="button" class="entry" data-action="select">
            <svg class="cut-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${KIND_ICONS[c.kind]}</svg>
            <span class="entry-text">${KIND_NAMES[c.kind]}</span>
            <span class="entry-size">${size} mm</span>
          </button>
          <button type="button" class="icon" data-action="remove" title="Entfernen">✕</button>
        </li>`;
      })
      .join('');
    const c = cutouts.find((c) => c.id === editor.selected);
    cutoutFields.hidden = !c;
    if (!c) return;
    const [wLabel, hLabel] = FIELD_LABELS[c.kind];
    const input = (key: keyof Cutout, label: string, min: number, max: number, step: number) =>
      `<label class="field"><span>${label}</span><input type="number" data-field="${key}" min="${min}" max="${max}" step="${step}" value="${c[key]}" /></label>`;
    cutoutFields.innerHTML =
      input('w', `${wLabel} (mm)`, 2, 300, 0.5) +
      (hLabel ? input('h', `${hLabel} (mm)`, 2, 300, 0.5) : '') +
      input('depth', 'Tiefe (mm)', 1, 160, 0.5) +
      (c.kind !== 'circle' ? input('angle', 'Winkel (°)', -180, 180, 1) : '');
  }

  // Keeps the numeric fields in step while a cutout is dragged.
  function syncFields() {
    const c = cutouts.find((c) => c.id === editor.selected);
    if (!c) return;
    for (const el of cutoutFields.querySelectorAll<HTMLInputElement>('input[data-field]')) {
      if (el !== document.activeElement) el.value = String(c[el.dataset.field as 'w' | 'h' | 'depth' | 'angle']);
    }
  }

  cutoutFields.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    const c = cutouts.find((c) => c.id === editor.selected);
    const v = Number(el.value);
    if (!c || !el.dataset.field || el.value === '' || !Number.isFinite(v)) return;
    const key = el.dataset.field as 'w' | 'h' | 'depth' | 'angle';
    c[key] = key === 'angle' ? v : Math.max(key === 'depth' ? 1 : 2, v);
    if (c.kind === 'circle' && key === 'w') c.h = c.w;
    editor.refresh();
    const size = cutoutList.querySelector(`li[data-id="${c.id}"] .entry-size`);
    if (size) size.textContent = c.kind === 'circle' ? `Ø ${num.format(c.w)} mm` : `${num.format(c.w)} × ${num.format(c.h)} mm`;
  });

  cutoutList.addEventListener('click', (e) => {
    const button = (e.target as Element).closest<HTMLButtonElement>('button[data-action]');
    const id = button?.closest('li')?.dataset.id;
    if (!button || !id) return;
    if (button.dataset.action === 'remove') {
      cutouts.splice(cutouts.findIndex((c) => c.id === id), 1);
      editor.select(editor.selected === id ? null : editor.selected);
      ctx.schedule();
    } else {
      editor.select(id);
    }
    renderCutouts();
  });

  for (const button of form.querySelectorAll<HTMLButtonElement>('[data-add]')) {
    button.addEventListener('click', () => addCutout(button.dataset.add as CutoutKind));
  }

  // ---------- Wiring ----------

  const pick = () => photoInput.click();
  $('photo-pick').addEventListener('click', pick);
  $('photo-pick-2').addEventListener('click', pick);
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
      if (file) setPhoto(file);
    });
  }
  $('contour-redetect').addEventListener('click', () => redetect());
  field<HTMLInputElement>('sensitivity').addEventListener('change', () => redetect());
  paperAdjust.addEventListener('click', adjustPaper);
  $('rotation-auto').addEventListener('click', () => {
    autoRotation();
    ctx.schedule();
  });

  // ---------- Persistence ----------

  const PERSISTED = ['offset', 'pocketDepth', 'rotation', 'cx', 'cy', 'cz', 'sensitivity'];

  function saveState() {
    try {
      const values = Object.fromEntries(PERSISTED.map((n) => [n, field<HTMLInputElement>(n).value]));
      localStorage.setItem(STATE_KEY, JSON.stringify({ outline, cutouts, values }));
    } catch {
      // Storage is optional.
    }
  }

  function restore() {
    try {
      const saved = localStorage.getItem(IMAGE_KEY);
      const state = JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null') as {
        outline: Pt[];
        cutouts: Cutout[];
        values: Record<string, string>;
      } | null;
      if (!saved || !state || state.outline.length < 3) return;
      image = saved;
      outline = state.outline;
      cutouts = state.cutouts;
      for (const [n, v] of Object.entries(state.values)) {
        const el = field<HTMLInputElement>(n);
        if (el && PERSISTED.includes(n)) el.value = v;
      }
      photoName.textContent = 'Foto der letzten Sitzung';
      editor.showContour(image, outline, cutouts);
      renderCutouts();
      updateTools();
    } catch {
      // Corrupt storage: start fresh.
    }
  }
  restore();

  return {
    updateReadouts,
    build,
    hasOutline: () => outline.length >= 3,
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
