import { PAPER, type Pt } from './detect';
import { local, shapeCenter, toLocal, type Contour, type Cutout } from './layout';

export interface Overlay {
  // Grown pockets, bin footprint and usable inner area, in paper millimeters.
  pocket: Pt[][];
  bin: Pt[];
  inner: Pt[];
}

interface Callbacks {
  // final: the user let go, a good moment to save.
  change(final: boolean): void;
  select(id: string | null): void;
}

type Drag =
  | { kind: 'vertex'; id: string; i: number }
  | { kind: 'shape'; id: string; last: Pt }
  | { kind: 'shapeRotate'; id: string; center: Pt; start: number; orig: Pt[] }
  | { kind: 'move'; id: string; dx: number; dy: number }
  | { kind: 'size'; id: string }
  | { kind: 'rotate'; id: string }
  | { kind: 'corner'; i: number }
  | { kind: 'pan'; x: number; y: number; view: View };

interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}

const HANDLE_PX = 5.5;
const ROTATE_GAP_PX = 28;
const MIN_SIZE = 2;

const fmt = (v: number) => Math.round(v * 100) / 100;
const pathOf = (pts: Pt[]) => (pts.length ? `M${pts.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join('L')}Z` : '');
const deg = (a: Pt, b: Pt) => (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;

export class ContourEditor {
  contours: Contour[] = [];
  cutouts: Cutout[] = [];
  // Id of the selected contour or cutout.
  selected: string | null = null;
  private mode: 'empty' | 'contour' | 'paper' = 'empty';
  // Rectified photo, or null for a blank sheet.
  private image: string | null = null;
  private size: Pt = PAPER;
  private overlay: Overlay | null = null;
  private view: View = { x: 0, y: 0, w: PAPER[0], h: PAPER[1] };
  private drag: Drag | null = null;
  // Small jitters of a click must not re-render, or double clicks get lost.
  private downAt: { x: number; y: number; moved: boolean } | null = null;
  // Pointer capture retargets dblclick to the svg, so double taps on a
  // vertex are detected here.
  private lastTap = { key: '', time: 0 };
  private paper: { corners: Pt[]; done: (corners: Pt[] | null) => void } | null = null;

  constructor(
    private svg: SVGSVGElement,
    private bar: HTMLElement,
    private empty: HTMLElement,
    private cb: Callbacks,
  ) {
    svg.addEventListener('pointerdown', (e) => this.onDown(e));
    svg.addEventListener('pointermove', (e) => this.onMove(e));
    svg.addEventListener('pointerup', () => this.onUp());
    svg.addEventListener('pointercancel', () => this.onUp());
    svg.addEventListener('contextmenu', (e) => {
      const target = (e.target as Element).closest<SVGElement>('[data-kind="vertex"]');
      if (!target) return;
      e.preventDefault();
      this.removeVertex(target.dataset.id!, Number(target.dataset.i));
    });
    svg.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    bar.addEventListener('click', (e) => this.onBar(e));
    new ResizeObserver(() => this.render()).observe(svg);
    this.showEmpty();
  }

  showEmpty(): void {
    this.mode = 'empty';
    this.svg.toggleAttribute('hidden', true);
    this.bar.hidden = true;
    this.empty.hidden = false;
  }

  showContour(image: string | null, contours: Contour[], cutouts: Cutout[]): void {
    this.mode = 'contour';
    this.image = image;
    this.size = PAPER;
    this.contours = contours;
    this.cutouts = cutouts;
    this.paper = null;
    this.show();
  }

  // Lets the user drag the four sheet corners on the original photo.
  showPaper(image: string, size: Pt, corners: Pt[], done: (corners: Pt[] | null) => void): void {
    this.mode = 'paper';
    this.image = image;
    this.size = size;
    this.paper = { corners: corners.map((c) => [...c] as Pt), done };
    this.show();
  }

  get isPaper(): boolean {
    return this.mode === 'paper';
  }

  setOverlay(overlay: Overlay | null): void {
    this.overlay = overlay;
    if (this.mode === 'contour' && !this.drag) this.render();
    else if (this.mode === 'contour') this.renderOverlay();
  }

  select(id: string | null): void {
    this.selected = id;
    this.render();
  }

  refresh(): void {
    this.render();
  }

  fit(): void {
    const [w, h] = this.size;
    const m = Math.max(w, h) * 0.04;
    this.view = { x: -m, y: -m, w: w + 2 * m, h: h + 2 * m };
    this.render();
  }

  private show(): void {
    this.svg.toggleAttribute('hidden', false);
    this.bar.hidden = false;
    this.empty.hidden = true;
    this.bar.innerHTML =
      this.mode === 'paper'
        ? `<span>Ziehe die vier Punkte auf die Ecken des Blatts.</span>
           <span class="bar-actions"><button type="button" class="ghost" data-bar="cancel">Abbrechen</button><button type="button" class="primary" data-bar="apply">Übernehmen</button></span>`
        : `<span>Kontur anklicken · Punkte ziehen · <b>+</b> fügt ein · Doppelklick löscht · Mausrad zoomt</span>
           <span class="bar-actions"><button type="button" class="ghost" data-bar="fit">Einpassen</button></span>`;
    this.fit();
  }

  private onBar(e: Event): void {
    const action = (e.target as Element).closest<HTMLElement>('[data-bar]')?.dataset.bar;
    if (action === 'fit') this.fit();
    if ((action === 'apply' || action === 'cancel') && this.paper) {
      const { corners, done } = this.paper;
      done(action === 'apply' ? corners : null);
    }
  }

  // ---------- Rendering ----------

  // Paper units per screen pixel.
  private unit(): number {
    const { clientWidth: cw, clientHeight: ch } = this.svg;
    if (!cw || !ch) return 1;
    return Math.max(this.view.w / cw, this.view.h / ch);
  }

  private render(): void {
    if (this.mode === 'empty') return;
    const { x, y, w, h } = this.view;
    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    const [iw, ih] = this.size;
    const r = HANDLE_PX * this.unit();
    let html = this.image
      ? `<image href="${this.image}" x="0" y="0" width="${iw}" height="${ih}" preserveAspectRatio="none" />`
      : `<rect class="blank-paper" x="0" y="0" width="${iw}" height="${ih}" />`;
    if (this.mode === 'paper' && this.paper) {
      const c = this.paper.corners;
      html += `<path class="sheet" d="${pathOf(c)}" />`;
      html += c
        .map(([cx, cy], i) => `<circle class="vtx corner" data-kind="corner" data-i="${i}" cx="${cx}" cy="${cy}" r="${r * 1.3}" />`)
        .join('');
    } else {
      html += `<rect class="paper-edge" x="0" y="0" width="${iw}" height="${ih}" />`;
      html += '<g class="overlay"></g>';
      html += this.contours
        .map((c) => `<path class="outline${c.id === this.selected ? ' selected' : ''}" data-kind="shape" data-id="${c.id}" d="${pathOf(c.points)}" />`)
        .join('');
      html += this.cutouts.map((c) => this.cutoutSvg(c)).join('');
      const shape = this.contours.find((c) => c.id === this.selected);
      if (shape) html += this.shapeHandlesSvg(shape, r);
      const cut = this.cutouts.find((c) => c.id === this.selected);
      if (cut) html += this.handlesSvg(cut, r);
    }
    this.svg.innerHTML = html;
    this.renderOverlay();
  }

  private renderOverlay(): void {
    const g = this.svg.querySelector('.overlay');
    if (!g) return;
    const o = this.overlay;
    g.innerHTML = o
      ? `<path class="bin" d="${pathOf(o.bin)}" /><path class="inner" d="${pathOf(o.inner)}" /><path class="pocket" d="${o.pocket.map(pathOf).join('')}" />`
      : '';
  }

  private shapeHandlesSvg(c: Contour, r: number): string {
    const pts = c.points;
    const n = pts.length;
    let html = pts
      .map((p, i) => {
        const q = pts[(i + 1) % n];
        return `<g class="mid" data-kind="mid" data-id="${c.id}" data-i="${i}" transform="translate(${fmt((p[0] + q[0]) / 2)} ${fmt((p[1] + q[1]) / 2)})"><circle r="${r * 0.8}" /><path d="M${-r * 0.45} 0H${r * 0.45}M0 ${-r * 0.45}V${r * 0.45}" /></g>`;
      })
      .join('');
    html += pts
      .map(([px, py], i) => `<circle class="vtx" data-kind="vertex" data-id="${c.id}" data-i="${i}" cx="${fmt(px)}" cy="${fmt(py)}" r="${r}" />`)
      .join('');
    // Rotation handle above the top of the contour.
    const [cx] = shapeCenter(pts);
    const top = Math.min(...pts.map((p) => p[1]));
    const hy = top - ROTATE_GAP_PX * this.unit();
    html += `<path class="stem shape-stem" d="M${fmt(cx)} ${fmt(top)}L${fmt(cx)} ${fmt(hy)}" /><circle class="vtx rot shape-rot" data-kind="shapeRotate" data-id="${c.id}" cx="${fmt(cx)}" cy="${fmt(hy)}" r="${r}" />`;
    return html;
  }

  private cutoutSvg(c: Cutout): string {
    const sel = c.id === this.selected ? ' selected' : '';
    const t = `transform="translate(${fmt(c.x)} ${fmt(c.y)}) rotate(${fmt(c.angle)})"`;
    const attrs = `class="cut ${c.kind}${sel}" data-kind="move" data-id="${c.id}"`;
    if (c.kind === 'text') {
      const glyphs = (c.glyphs ?? []).map((poly) => pathOf(poly.map(([x, y]): Pt => [x * c.h, y * c.h]))).join('');
      return `<g ${attrs} ${t}><rect class="text-box" x="${-c.w / 2}" y="${-c.h / 2}" width="${c.w}" height="${c.h}" /><path class="glyph" d="${glyphs}" /></g>`;
    }
    if (c.kind === 'circle') return `<circle ${attrs} cx="${fmt(c.x)}" cy="${fmt(c.y)}" r="${fmt(c.w / 2)}" />`;
    const rx = c.kind === 'grip' ? Math.min(c.w, c.h) / 2 : 0;
    return `<rect ${attrs} ${t} x="${-c.w / 2}" y="${-c.h / 2}" width="${c.w}" height="${c.h}" rx="${rx}" />`;
  }

  private handlesSvg(c: Cutout, r: number): string {
    const [sx, sy] = c.kind === 'circle' ? local(c, [c.w / 2, 0]) : local(c, [c.w / 2, c.h / 2]);
    let html = `<rect class="vtx size" data-kind="size" data-id="${c.id}" x="${sx - r}" y="${sy - r}" width="${2 * r}" height="${2 * r}" />`;
    if (c.kind !== 'circle') {
      const [ax, ay] = local(c, [0, -c.h / 2]);
      const [rx, ry] = local(c, [0, -c.h / 2 - ROTATE_GAP_PX * this.unit()]);
      html += `<path class="stem" d="M${ax} ${ay}L${rx} ${ry}" /><circle class="vtx rot" data-kind="rotate" data-id="${c.id}" cx="${rx}" cy="${ry}" r="${r}" />`;
    }
    return html;
  }

  // ---------- Interaction ----------

  private point(e: { clientX: number; clientY: number }): Pt {
    const m = this.svg.getScreenCTM();
    if (!m) return [0, 0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [p.x, p.y];
  }

  private setSelected(id: string | null): void {
    if (this.selected === id) return;
    this.selected = id;
    this.cb.select(id);
    this.render();
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 && e.button !== 1) return;
    const target = (e.target as Element).closest<SVGElement>('[data-kind]');
    const kind = target?.dataset.kind;
    const i = Number(target?.dataset.i);
    const id = target?.dataset.id ?? '';
    const p = this.point(e);
    const shape = this.contours.find((c) => c.id === id);
    if (e.button === 1 || !kind) {
      this.drag = { kind: 'pan', x: e.clientX, y: e.clientY, view: { ...this.view } };
      if (e.button === 0) this.setSelected(null);
    } else if (kind === 'mid' && shape) {
      shape.points.splice(i + 1, 0, p);
      this.drag = { kind: 'vertex', id, i: i + 1 };
      this.render();
      this.cb.change(false);
    } else if (kind === 'vertex') {
      const key = `${id}:${i}`;
      const double = this.lastTap.key === key && e.timeStamp - this.lastTap.time < 400;
      this.lastTap = { key, time: e.timeStamp };
      if (double) {
        this.lastTap.key = '';
        this.removeVertex(id, i);
        e.preventDefault();
        return;
      }
      this.drag = { kind: 'vertex', id, i };
    } else if (kind === 'shape' && shape) {
      this.drag = { kind: 'shape', id, last: p };
      this.setSelected(id);
    } else if (kind === 'shapeRotate' && shape) {
      const center = shapeCenter(shape.points);
      this.drag = { kind: 'shapeRotate', id, center, start: deg(center, p), orig: shape.points.map((q) => [...q] as Pt) };
    } else if (kind === 'corner') {
      this.drag = { kind, i };
    } else if (kind === 'move') {
      const c = this.cutouts.find((c) => c.id === id)!;
      this.drag = { kind: 'move', id, dx: c.x - p[0], dy: c.y - p[1] };
      this.setSelected(id);
    } else if (kind === 'size' || kind === 'rotate') {
      this.drag = { kind, id };
    }
    this.downAt = { x: e.clientX, y: e.clientY, moved: kind === 'mid' };
    this.svg.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  private onMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || !this.downAt) return;
    if (!this.downAt.moved && Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) < 3) return;
    this.downAt.moved = true;
    if (d.kind === 'pan') {
      const u = this.unit();
      this.view = { ...d.view, x: d.view.x - (e.clientX - d.x) * u, y: d.view.y - (e.clientY - d.y) * u };
      this.render();
      return;
    }
    const p = this.point(e);
    if (d.kind === 'corner') {
      if (this.paper) this.paper.corners[d.i] = p;
      this.render();
      return;
    }
    if (d.kind === 'vertex' || d.kind === 'shape' || d.kind === 'shapeRotate') {
      const shape = this.contours.find((c) => c.id === d.id);
      if (!shape) return;
      if (d.kind === 'vertex') {
        shape.points[d.i] = p;
      } else if (d.kind === 'shape') {
        const [dx, dy] = [p[0] - d.last[0], p[1] - d.last[1]];
        for (const q of shape.points) {
          q[0] += dx;
          q[1] += dy;
        }
        d.last = p;
      } else {
        const step = e.shiftKey ? 15 : 1;
        const a = (Math.round((deg(d.center, p) - d.start) / step) * step * Math.PI) / 180;
        const [cx, cy] = d.center;
        const [c, s] = [Math.cos(a), Math.sin(a)];
        shape.points.forEach((q, k) => {
          const [ox, oy] = [d.orig[k][0] - cx, d.orig[k][1] - cy];
          q[0] = cx + ox * c - oy * s;
          q[1] = cy + ox * s + oy * c;
        });
      }
    } else {
      const c = this.cutouts.find((c) => c.id === d.id);
      if (!c) return;
      if (d.kind === 'move') {
        c.x = fmt(p[0] + d.dx);
        c.y = fmt(p[1] + d.dy);
      } else if (d.kind === 'size') {
        const [lx, ly] = toLocal(c, p);
        if (c.kind === 'circle') {
          c.w = c.h = fmt(Math.max(MIN_SIZE, 2 * Math.hypot(lx, ly)));
        } else if (c.kind === 'text') {
          // Texts keep their proportions.
          const f = Math.max((2 * Math.abs(lx)) / c.w, (2 * Math.abs(ly)) / c.h);
          const h = Math.max(MIN_SIZE, c.h * f);
          c.w = fmt((c.w * h) / c.h);
          c.h = fmt(h);
        } else {
          c.w = fmt(Math.max(MIN_SIZE, 2 * Math.abs(lx)));
          c.h = fmt(Math.max(MIN_SIZE, 2 * Math.abs(ly)));
        }
      } else if (d.kind === 'rotate') {
        const step = e.shiftKey ? 15 : 1;
        c.angle = normalizeAngle(Math.round((deg([c.x, c.y], p) + 90) / step) * step);
      }
    }
    this.render();
    this.cb.change(false);
  }

  private onUp(): void {
    if (!this.drag) return;
    const changed = this.drag.kind !== 'pan' && this.drag.kind !== 'corner' && !!this.downAt?.moved;
    this.drag = null;
    this.downAt = null;
    if (changed) this.cb.change(true);
  }

  private removeVertex(id: string, i: number): void {
    const shape = this.contours.find((c) => c.id === id);
    if (!shape || shape.points.length <= 3) return;
    shape.points.splice(i, 1);
    this.render();
    this.cb.change(true);
  }

  private onWheel(e: WheelEvent): void {
    if (this.mode === 'empty') return;
    e.preventDefault();
    const [px, py] = this.point(e);
    const f = Math.min(4, Math.max(0.25, 1.0015 ** e.deltaY));
    const maxW = Math.max(...this.size) * 3;
    const w = Math.min(maxW, Math.max(15, this.view.w * f));
    const k = w / this.view.w;
    this.view = { x: px - (px - this.view.x) * k, y: py - (py - this.view.y) * k, w, h: this.view.h * k };
    this.render();
  }
}

// −180 < angle ≤ 180.
export function normalizeAngle(a: number): number {
  const r = ((a % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;
}
