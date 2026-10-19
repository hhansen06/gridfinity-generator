import './style.css';
import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from './geometry/manifold';
import { collectGarbage } from './geometry/gc';
import { strToU8, zipSync } from 'fflate';
import {
  buildBaseplate,
  buildBin,
  GRID,
  HEIGHT_UNIT,
  type BinResult,
  type LabelIcon,
  type Shape2D,
} from './geometry/gridfinity';
import { layoutDrawer, type DrawerLayout, type PadMode, type PlateType } from './baseplates';
import { textToShape } from './geometry/text';
import { loadFont } from './fonts';
import { loadImage, rasterToShape, svgToShape } from './logo';
import { Viewer } from './viewer';
import { toBinaryStl } from './stl';
import { toThreeMf, type Model3mf } from './threemf';
import { DRIVES, findSymbol, HEADS, symbolToSvg, type SymbolDef } from './symbols';
import { CUSTOM_PREFIX, loadCustomTypes, saveCustomTypes, SCREW_PRESETS, screwTypeLabel, type ScrewType } from './screws';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>('form');
const statsEl = $('stats');
const statusEl = $('status');
const downloadBtn = $<HTMLButtonElement>('download');
const download3mfBtn = $<HTMLButtonElement>('download-3mf');
const logoInput = $<HTMLInputElement>('logo-input');
const logoName = $('logo-name');
const logoClear = $<HTMLButtonElement>('logo-clear');
const logoError = $('logo-error');
const rasterOptions = $('raster-options');
const batchList = $<HTMLUListElement>('batch-list');
const batchText = $<HTMLTextAreaElement>('batch-text');
const batchDownloadBtn = $<HTMLButtonElement>('batch-download');
const screwSelect = $<HTMLSelectElement>('screw-type');
const showNormInput = $<HTMLInputElement>('show-norm');
const screwDeleteBtn = $<HTMLButtonElement>('screw-delete');
const plateList = $<HTMLUListElement>('plate-list');

const escapeHtml = (s: string) =>
  s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

function buildPicker(container: HTMLElement, name: string, symbols: SymbolDef[], selected: string) {
  const none = `<label class="tile" title="Ohne"><input type="radio" name="${name}" value=""${selected ? '' : ' checked'} /><span class="none">Ohne</span></label>`;
  container.innerHTML =
    none +
    symbols
      .map(
        (s) =>
          `<label class="tile" title="${s.name}"><input type="radio" name="${name}" value="${s.id}"${s.id === selected ? ' checked' : ''} />${symbolToSvg(s)}</label>`,
      )
      .join('');
}
buildPicker($('head-picker'), 'head', HEADS, 'flat');
buildPicker($('drive-picker'), 'drive', DRIVES, 'phillips');

let customTypes = loadCustomTypes();
const findScrewType = (id: string): ScrewType | null =>
  [...SCREW_PRESETS, ...customTypes].find((t) => t.id === id) ?? null;

function renderScrewTypes(selected: string) {
  const options = (types: ScrewType[]) =>
    types.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(screwTypeLabel(t))}</option>`).join('');
  screwSelect.innerHTML =
    '<option value="">Individuell</option>' +
    `<optgroup label="Normteile">${options(SCREW_PRESETS)}</optgroup>` +
    (customTypes.length ? `<optgroup label="Eigene Typen">${options(customTypes)}</optgroup>` : '');
  screwSelect.value = findScrewType(selected) ? selected : '';
}
renderScrewTypes('');

function setRadio(name: string, value: string) {
  const radio = form.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
  if (radio) radio.checked = true;
}

const viewer = new Viewer($('viewer'));
const mm = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });

type Logo = { kind: 'svg'; shape: Shape2D } | { kind: 'raster'; image: HTMLImageElement };
let logo: Logo | null = null;
let wasm: ManifoldToplevel | null = null;
let lastResult: BinResult | null = null;
let lastPlates: { layout: DrawerLayout; meshes: Map<string, BinResult>; name: string } | null = null;
let generation = 0;

// Everything needed to rebuild one box; plain data so it can be stored.
interface BoxConfig {
  x: number;
  y: number;
  z: number;
  lip: boolean;
  magnets: boolean;
  label: boolean;
  text: string;
  font: string;
  textSize: number;
  relief: 'raised' | 'engraved' | 'inlay';
  align: 'left' | 'center';
  depth: number;
  head: string;
  drive: string;
  screwType: string;
  // Norm of the screw type at the time the box was configured.
  norm: string;
  showNorm: boolean;
  logo: Shape2D | null;
}

// Text as it goes on the label, with the norm as an extra line if wanted.
const labelText = (c: BoxConfig) => [c.text, c.showNorm ? c.norm : ''].filter(Boolean).join('\n');

function readForm() {
  const data = new FormData(form);
  const num = (name: string, min: number, max: number) =>
    Math.min(max, Math.max(min, Math.round(Number(data.get(name)) || min)));
  return {
    mode: data.get('mode') === 'plate' ? ('plate' as const) : ('box' as const),
    drawerW: Number(data.get('drawerW')) || 0,
    drawerD: Number(data.get('drawerD')) || 0,
    clearance: Math.max(0, Number(data.get('clearance')) || 0),
    bed: Math.max(60, Number(data.get('bed')) || 0),
    padMode: data.get('padMode') as PadMode,
    plateMagnets: data.has('plateMagnets'),
    x: num('x', 1, 10),
    y: num('y', 1, 10),
    z: num('z', 1, 25),
    lip: data.has('lip'),
    magnets: data.has('magnets'),
    label: data.has('label'),
    text: String(data.get('text') ?? '').trim(),
    font: String(data.get('font')),
    textSize: Number(data.get('textSize')) || 8,
    relief: data.get('relief') as BoxConfig['relief'],
    bodyColor: String(data.get('bodyColor')),
    reliefColor: String(data.get('reliefColor')),
    align: data.get('align') as BoxConfig['align'],
    depth: Number(data.get('depth')),
    threshold: Number(data.get('threshold')),
    invert: data.has('invert'),
    head: String(data.get('head') ?? ''),
    drive: String(data.get('drive') ?? ''),
    screwType: String(data.get('screwType') ?? ''),
    showNorm: data.has('showNorm'),
  };
}
type FormState = ReturnType<typeof readForm>;

function updateReadouts(s: FormState) {
  const set = (key: string, value: string) => {
    const el = form.querySelector<HTMLElement>(`[data-mm="${key}"]`);
    if (el) el.textContent = value;
  };
  set('x', `${mm.format(s.x * GRID - 0.5)} mm`);
  set('y', `${mm.format(s.y * GRID - 0.5)} mm`);
  set('z', `${mm.format(s.z * HEIGHT_UNIT)} mm`);
  document.body.dataset.mode = s.mode;
  if (s.mode === 'box') downloadBtn.textContent = 'STL';
  download3mfBtn.textContent = s.mode === 'plate' ? '3MF' : '3MF mit Farben';
  download3mfBtn.title = s.mode === 'plate' ? 'Alle Platten in einer Datei' : 'Box und Schrift als getrennte Teile mit Farben';
  $('threshold-out').textContent = String(s.threshold);
  $('depth-out').textContent = mm.format(s.depth);
  $('head-out').textContent = findSymbol(HEADS, s.head)?.name ?? 'ohne';
  $('drive-out').textContent = findSymbol(DRIVES, s.drive)?.name ?? 'ohne';
  $('label-fields').classList.toggle('disabled', !s.label);
  showNormInput.disabled = !findScrewType(s.screwType)?.norm;
  screwDeleteBtn.hidden = !s.screwType.startsWith(CUSTOM_PREFIX);
  rasterOptions.hidden = logo?.kind !== 'raster';
  viewer.setColors(s.bodyColor, s.reliefColor);
  document.documentElement.style.setProperty('--body-color', s.bodyColor);
  document.documentElement.style.setProperty('--relief-color', s.reliefColor);
}

function currentConfig(s: FormState): BoxConfig {
  let logoData: Shape2D | null = null;
  if (logo) {
    try {
      logoData = logo.kind === 'svg' ? logo.shape : rasterToShape(logo.image, s.threshold, s.invert);
      logoError.hidden = true;
    } catch (err) {
      showLogoError(err);
    }
  }
  const { x, y, z, lip, magnets, label, text, font, textSize, relief, align, depth, head, drive, screwType, showNorm } = s;
  const norm = findScrewType(screwType)?.norm ?? '';
  return {
    x, y, z, lip, magnets, label, text, font, textSize, relief, align, depth, head, drive,
    screwType, norm, showNorm, logo: logoData,
  };
}

async function buildConfig(m: ManifoldToplevel, c: BoxConfig): Promise<BinResult> {
  const labelActive = c.label && c.z >= 2;
  const content = labelText(c);
  const text = labelActive && content ? textToShape(await loadFont(c.font), content, c.align) : null;
  const icons: LabelIcon[] = [];
  if (labelActive) {
    if (c.logo) icons.push({ shape: c.logo, aspect: 3 });
    for (const symbol of [findSymbol(HEADS, c.head), findSymbol(DRIVES, c.drive)]) if (symbol) icons.push(symbol);
  }
  try {
    return buildBin(m, {
      x: c.x,
      y: c.y,
      z: c.z,
      lip: c.lip,
      magnets: c.magnets,
      label: labelActive
        ? { depth: c.depth, relief: c.relief, align: c.align, text, textSize: c.textSize, icons }
        : null,
    });
  } finally {
    collectGarbage();
  }
}

async function generate() {
  const run = ++generation;
  const s = readForm();
  updateReadouts(s);
  if (!wasm) return;

  const started = performance.now();
  if (s.mode === 'plate') return generatePlates(s, run, started);
  let result: BinResult;
  try {
    result = await buildConfig(wasm, currentConfig(s));
  } catch (err) {
    console.error(err);
    setStatus('Die Geometrie konnte nicht erzeugt werden. Bitte Eingaben prüfen.');
    return;
  }
  if (run !== generation) return;
  lastResult = result;
  lastPlates = null;
  setStatus(null);
  viewer.show(result, s.x, s.y);

  const [w, d, h] = result.size;
  const tris = (result.body.indices.length + (result.relief?.indices.length ?? 0)) / 3;
  const note = s.label && s.z < 2 ? '<br><span class="warn">Beschriftung erst ab Höhe 2.</span>' : '';
  statsEl.innerHTML =
    `<strong>${mm.format(w)} × ${mm.format(d)} × ${mm.format(h)} mm</strong>` +
    `<br>${tris.toLocaleString('de-DE')} Dreiecke · ${Math.round(performance.now() - started)} ms${note}`;
  downloadBtn.disabled = false;
  download3mfBtn.disabled = false;
}

// ---------- Baseplates für eine Schublade ----------

const plateCache = new Map<string, BinResult>();

function plateKey(t: PlateType) {
  return JSON.stringify([t.x, t.y, t.pad, t.magnets]);
}

function buildPlate(m: ManifoldToplevel, t: PlateType): BinResult {
  const key = plateKey(t);
  let result = plateCache.get(key);
  if (!result) {
    try {
      result = buildBaseplate(m, { x: t.x, y: t.y, pad: t.pad, magnets: t.magnets });
    } finally {
      collectGarbage();
    }
    if (plateCache.size > 40) plateCache.clear();
    plateCache.set(key, result);
  }
  return result;
}

const plateTitle = (t: PlateType) => `Platte ${t.name} (${t.x}×${t.y})`;

function renderPlates(layout: DrawerLayout | null) {
  const plates = layout?.plates ?? [];
  plateList.innerHTML = plates
    .map((t) => {
      const padded = Object.values(t.pad).some((v) => v > 0) ? ' + Rand' : '';
      return `<li>
        <span class="entry">
          <span class="plate-name">${t.name}</span>
          <span class="entry-text">${t.x}×${t.y} Felder${padded}<small>${mm.format(t.size[0])} × ${mm.format(t.size[1])} mm</small></span>
          <span class="entry-size">${t.positions.length}×</span>
        </span>
        <button type="button" class="icon" data-plate="${t.name}" title="${plateTitle(t)} als STL">STL</button>
      </li>`;
    })
    .join('');
  $('plate-count').textContent = layout ? String(layout.count) : '';
}

async function generatePlates(s: FormState, run: number, started: number) {
  const layout = layoutDrawer({
    width: s.drawerW,
    depth: s.drawerD,
    clearance: s.clearance,
    bed: s.bed,
    pad: s.padMode,
    magnets: s.plateMagnets,
  });
  if (typeof layout === 'string') {
    lastPlates = null;
    renderPlates(null);
    setStatus(layout);
    statsEl.textContent = '';
    downloadBtn.disabled = download3mfBtn.disabled = true;
    return;
  }

  const meshes = new Map<string, BinResult>();
  try {
    for (const t of layout.plates) meshes.set(t.name, buildPlate(wasm!, t));
  } catch (err) {
    console.error(err);
    setStatus('Die Geometrie konnte nicht erzeugt werden. Bitte Eingaben prüfen.');
    return;
  }
  if (run !== generation) return;
  lastResult = null;
  lastPlates = { layout, meshes, name: `baseplate_${mm.format(s.drawerW)}x${mm.format(s.drawerD)}` };
  setStatus(null);
  renderPlates(layout);
  const height = [...meshes.values()][0].size[2];
  viewer.showPlates(
    layout.plates.flatMap((t) => t.positions.map((p) => ({ mesh: meshes.get(t.name)!.body, ...p }))),
    [s.drawerW, s.drawerD],
    height,
  );

  const n = layout.count;
  const types = layout.plates.length;
  statsEl.innerHTML =
    `<strong>${layout.cellsX} × ${layout.cellsY} Felder · ${n} ${n === 1 ? 'Platte' : 'Platten'}` +
    (types > 1 ? ` in ${types} Varianten` : '') +
    '</strong>' +
    `<br>Luft zur Schublade: ${mm.format(layout.gapX)} × ${mm.format(layout.gapY)} mm · ` +
    `${height.toLocaleString('de-DE', { maximumFractionDigits: 2 })} mm hoch · ${Math.round(performance.now() - started)} ms`;
  downloadBtn.textContent = types > 1 ? 'STL (ZIP)' : 'STL';
  downloadBtn.disabled = download3mfBtn.disabled = false;
}

const plateModel = (t: PlateType, result: BinResult): Model3mf => ({
  name: plateTitle(t),
  parts: [{ name: 'Baseplate', mesh: result.body, color: 0 }],
  size: [result.size[0], result.size[1]],
});

const plateFileName = (t: PlateType) => `baseplate_${t.name}_${t.x}x${t.y}_${t.positions.length}x.stl`;

plateList.addEventListener('click', (ev) => {
  const name = (ev.target as Element).closest<HTMLButtonElement>('button[data-plate]')?.dataset.plate;
  const type = lastPlates?.layout.plates.find((t) => t.name === name);
  if (!lastPlates || !type) return;
  saveFile(toBinaryStl([lastPlates.meshes.get(type.name)!.body]), plateFileName(type));
});

// One STL per plate variant; several variants go into a ZIP.
async function downloadPlatesStl() {
  if (!lastPlates) return;
  const { layout, meshes, name } = lastPlates;
  if (layout.plates.length === 1) {
    const t = layout.plates[0];
    saveFile(toBinaryStl([meshes.get(t.name)!.body]), plateFileName(t));
    return;
  }
  const files: Record<string, Uint8Array> = {};
  for (const t of layout.plates) {
    files[plateFileName(t)] = new Uint8Array(await toBinaryStl([meshes.get(t.name)!.body]).arrayBuffer());
  }
  const readme = layout.plates.map((t) => `${plateTitle(t)}: ${t.positions.length}× drucken`).join('\n');
  files['LIESMICH.txt'] = strToU8(`Schublade ${name.replace('baseplate_', '')} mm\n\n${readme}\n`);
  saveFile(new Blob([zipSync(files)], { type: 'application/zip' }), `${name}.zip`);
}

let timer = 0;
function scheduleGenerate(e?: Event) {
  if (e?.target instanceof Element && e.target.closest('#batch, #screw-save')) return;
  // Readouts (and the mode switch) react at once; only the geometry waits.
  updateReadouts(readForm());
  clearTimeout(timer);
  timer = window.setTimeout(generate, 150);
}

function setStatus(message: string | null) {
  statusEl.hidden = !message;
  statusEl.textContent = message ?? '';
}

function showLogoError(err: unknown) {
  logoError.hidden = false;
  logoError.textContent = err instanceof Error ? err.message : String(err);
}

async function setLogo(file: File) {
  logoError.hidden = true;
  try {
    const isSvg = file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');
    logo = isSvg ? { kind: 'svg', shape: svgToShape(await file.text()) } : { kind: 'raster', image: await loadImage(file) };
    setLogoName(file.name);
  } catch (err) {
    clearLogo();
    showLogoError(err);
  }
  scheduleGenerate();
}

function setLogoName(name: string) {
  logoName.textContent = name;
  logoName.classList.remove('muted');
  logoClear.hidden = false;
}

function clearLogo() {
  logo = null;
  logoInput.value = '';
  logoName.textContent = 'SVG, PNG oder JPG';
  logoName.classList.add('muted');
  logoClear.hidden = true;
}

// Picking a screw type sets head and drive; changing either by hand leaves the type.
form.addEventListener('change', (e) => {
  const target = e.target as HTMLInputElement | HTMLSelectElement;
  const type = findScrewType(screwSelect.value);
  if (target === screwSelect && type) {
    setRadio('head', type.head);
    setRadio('drive', type.drive);
  } else if ((target.name === 'head' || target.name === 'drive') && type) {
    const s = readForm();
    if (s.head !== type.head || s.drive !== type.drive) screwSelect.value = '';
  }
});
form.addEventListener('input', scheduleGenerate);
form.addEventListener('change', scheduleGenerate);
form.addEventListener('submit', (e) => e.preventDefault());

$('logo-pick').addEventListener('click', () => logoInput.click());
logoInput.addEventListener('change', () => {
  const file = logoInput.files?.[0];
  if (file) setLogo(file);
});
logoClear.addEventListener('click', () => {
  clearLogo();
  logoError.hidden = true;
  scheduleGenerate();
});

const drop = $('logo-drop');
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const file = e.dataTransfer?.files[0];
  if (file) setLogo(file);
});

const slugify = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);

function fileBaseName(c: BoxConfig) {
  const slug = c.label && c.text ? '_' + slugify(c.text) : '';
  return `gridfinity_${c.x}x${c.y}x${c.z}${slug}`;
}

function saveFile(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function toModel(name: string, result: BinResult): Model3mf {
  const parts = [{ name: 'Box', mesh: result.body, color: 0 }];
  if (result.relief) parts.push({ name: 'Beschriftung', mesh: result.relief, color: 1 });
  return { name, parts, size: [result.size[0], result.size[1]] };
}

const palette = (s: FormState) => [s.bodyColor, s.reliefColor];

downloadBtn.addEventListener('click', () => {
  if (readForm().mode === 'plate') {
    downloadPlatesStl();
    return;
  }
  if (!lastResult) return;
  const meshes = lastResult.relief ? [lastResult.body, lastResult.relief] : [lastResult.body];
  saveFile(toBinaryStl(meshes), `${fileBaseName(currentConfig(readForm()))}.stl`);
});

download3mfBtn.addEventListener('click', () => {
  const s = readForm();
  if (s.mode === 'plate') {
    if (!lastPlates) return;
    const { layout, meshes, name } = lastPlates;
    const models = layout.plates.flatMap((t) => t.positions.map(() => plateModel(t, meshes.get(t.name)!)));
    saveFile(toThreeMf(models, [s.bodyColor]), `${name}.3mf`);
    return;
  }
  if (!lastResult) return;
  const name = fileBaseName(currentConfig(s));
  saveFile(toThreeMf([toModel(name, lastResult)], palette(s)), `${name}.3mf`);
});

// ---------- Stapelliste: mehrere Boxen in einer 3MF-Datei ----------

interface ListEntry extends BoxConfig {
  id: string;
}

const STORAGE_KEY = 'gridfinity-batch-v1';
let batch: ListEntry[] = loadBatch();

function loadBatch(): ListEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // Entries saved before screw types existed lack these fields.
    return raw ? (JSON.parse(raw) as ListEntry[]).map((e) => ({ ...e, screwType: e.screwType ?? '', norm: e.norm ?? '', showNorm: e.showNorm ?? false })) : [];
  } catch {
    return [];
  }
}

function saveBatch() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(batch));
  } catch {
    // Storage is optional; the list still works for this session.
  }
}

const entryTitle = (e: BoxConfig) => (e.label && labelText(e) ? labelText(e).replace(/\n/g, ' / ') : 'Ohne Text');

function renderBatch() {
  batchList.innerHTML = batch
    .map((e) => {
      const head = findSymbol(HEADS, e.head);
      const drive = findSymbol(DRIVES, e.drive);
      const icons = [head, drive].map((s) => (s ? `<span class="mini" title="${s.name}">${symbolToSvg(s)}</span>` : '')).join('');
      return `<li data-id="${e.id}">
        <button type="button" class="entry" data-action="load" title="In den Editor laden">
          <span class="icons">${icons}${e.logo ? '<span class="mini logo-mark" title="Eigenes Logo">L</span>' : ''}</span>
          <span class="entry-text">${escapeHtml(entryTitle(e))}</span>
          <span class="entry-size">${e.x}×${e.y}×${e.z}</span>
        </button>
        <button type="button" class="icon" data-action="remove" title="Entfernen">✕</button>
      </li>`;
    })
    .join('');
  const n = batch.length;
  $('batch-count').textContent = n ? String(n) : '';
  $('batch-empty').hidden = n > 0;
  $('batch-clear').hidden = n === 0;
  batchDownloadBtn.hidden = n === 0;
  batchDownloadBtn.textContent = `Liste als 3MF (${n} ${n === 1 ? 'Box' : 'Boxen'})`;
}

function addToBatch(configs: BoxConfig[]) {
  batch.push(...configs.map((c) => ({ ...c, id: crypto.randomUUID() })));
  saveBatch();
  renderBatch();
}

function loadIntoForm(e: BoxConfig) {
  const set = (name: string, value: string) => {
    const el = form.elements.namedItem(name) as HTMLInputElement | null;
    if (el) el.value = value;
  };
  const check = (name: string, value: boolean) => {
    const el = form.elements.namedItem(name) as HTMLInputElement | null;
    if (el) el.checked = value;
  };
  set('x', String(e.x));
  set('y', String(e.y));
  set('z', String(e.z));
  check('lip', e.lip);
  check('magnets', e.magnets);
  check('label', e.label);
  set('text', e.text);
  set('font', e.font);
  set('textSize', String(e.textSize));
  set('relief', e.relief);
  set('align', e.align);
  set('depth', String(e.depth));
  setRadio('head', e.head);
  setRadio('drive', e.drive);
  screwSelect.value = findScrewType(e.screwType) ? e.screwType : '';
  check('showNorm', e.showNorm);
  if (e.logo) {
    logo = { kind: 'svg', shape: e.logo };
    setLogoName('Logo aus der Liste');
  } else {
    clearLogo();
  }
  scheduleGenerate();
}

$('batch-add').addEventListener('click', () => addToBatch([currentConfig(readForm())]));

$('batch-add-lines').addEventListener('click', () => {
  const base = currentConfig(readForm());
  // "|" inside a line becomes a line break on the label.
  const texts = batchText.value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split('|').map((part) => part.trim()).join('\n'));
  if (texts.length === 0) return;
  addToBatch(texts.map((text) => ({ ...base, label: true, text })));
  batchText.value = '';
});

batchList.addEventListener('click', (ev) => {
  const button = (ev.target as Element).closest<HTMLButtonElement>('button[data-action]');
  const id = button?.closest('li')?.dataset.id;
  const entry = batch.find((e) => e.id === id);
  if (!button || !entry) return;
  if (button.dataset.action === 'remove') {
    batch = batch.filter((e) => e !== entry);
    saveBatch();
    renderBatch();
  } else {
    loadIntoForm(entry);
  }
});

// Two clicks instead of a confirm() dialog, so a stray click cannot destroy anything.
function onConfirmedClick(button: HTMLButtonElement, question: string, action: () => void) {
  const label = button.textContent;
  let armed = 0;
  button.addEventListener('click', () => {
    if (!armed) {
      button.textContent = question;
      armed = window.setTimeout(() => {
        armed = 0;
        button.textContent = label;
      }, 3000);
      return;
    }
    clearTimeout(armed);
    armed = 0;
    button.textContent = label;
    action();
  });
}

onConfirmedClick($<HTMLButtonElement>('batch-clear'), 'Wirklich leeren?', () => {
  batch = [];
  saveBatch();
  renderBatch();
});

onConfirmedClick(screwDeleteBtn, 'Wirklich löschen?', () => {
  customTypes = customTypes.filter((t) => t.id !== screwSelect.value);
  saveCustomTypes(customTypes);
  renderScrewTypes('');
  scheduleGenerate();
});

$('screw-save-btn').addEventListener('click', () => {
  const nameInput = $<HTMLInputElement>('screw-name');
  const normInput = $<HTMLInputElement>('screw-norm');
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.focus();
    return;
  }
  const { head, drive } = readForm();
  const type: ScrewType = { id: CUSTOM_PREFIX + crypto.randomUUID(), name, norm: normInput.value.trim(), head, drive };
  customTypes.push(type);
  saveCustomTypes(customTypes);
  renderScrewTypes(type.id);
  nameInput.value = '';
  normInput.value = '';
  $<HTMLDetailsElement>('screw-save').open = false;
  scheduleGenerate();
});

batchDownloadBtn.addEventListener('click', async () => {
  if (!wasm || batch.length === 0) return;
  const m = wasm;
  batchDownloadBtn.disabled = true;
  try {
    const models: Model3mf[] = [];
    for (const [i, entry] of batch.entries()) {
      batchDownloadBtn.textContent = `Erzeuge ${i + 1} von ${batch.length} …`;
      // Let the button text paint before the next synchronous geometry build.
      await new Promise((r) => setTimeout(r, 0));
      models.push(toModel(`${entryTitle(entry)} (${entry.x}×${entry.y}×${entry.z})`, await buildConfig(m, entry)));
    }
    saveFile(toThreeMf(models, palette(readForm())), `gridfinity_liste_${batch.length}.3mf`);
  } catch (err) {
    console.error(err);
    setStatus('Die Liste konnte nicht erzeugt werden.');
  } finally {
    batchDownloadBtn.disabled = false;
    renderBatch();
  }
});

renderBatch();
updateReadouts(readForm());
loadManifold()
  .then((m) => {
    wasm = m;
    return generate();
  })
  .catch((err) => {
    console.error(err);
    setStatus('Die Geometrie-Engine konnte nicht geladen werden.');
  });
