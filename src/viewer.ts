import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { BinResult, MeshData } from './geometry/gridfinity';
import { GRID } from './geometry/gridfinity';

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
  private controls: OrbitControls;
  private group = new THREE.Group();
  private grid: THREE.GridHelper | null = null;
  private bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.55, metalness: 0.05 });
  private reliefMaterial = new THREE.MeshStandardMaterial({ color: 0xf28c28, roughness: 0.5 });
  // Neighboring baseplates alternate in loud colors so each plate stands out.
  private plateMaterials = [0xffd400, 0xe8212b].map(
    (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 }),
  );
  private outlineMaterial = new THREE.LineBasicMaterial({ color: 0xf28c28 });
  private lastSize = '';

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-1, -2, 3);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 0.8);
    rim.position.set(2, 1.5, 1);
    this.scene.add(rim);
    this.scene.add(this.group);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  setColors(body: string, relief: string): void {
    this.bodyMaterial.color.set(body);
    this.reliefMaterial.color.set(relief);
    this.outlineMaterial.color.set(relief);
  }

  private clear(): void {
    for (const child of [...this.group.children]) {
      (child as THREE.Mesh).geometry.dispose();
      this.group.remove(child);
    }
  }

  show(result: BinResult, gridX: number, gridY: number): void {
    this.clear();
    this.group.add(new THREE.Mesh(toGeometry(result.body), this.bodyMaterial));
    if (result.relief) this.group.add(new THREE.Mesh(toGeometry(result.relief), this.reliefMaterial));

    const [w, d, h] = result.size;
    const sizeKey = `${gridX}x${gridY}x${h}`;
    if (sizeKey !== this.lastSize) {
      this.updateGrid(gridX, gridY);
      this.frame(w, d, h);
      this.lastSize = sizeKey;
    }
  }

  // Plates are placed at their drawer positions; the drawer is drawn as an outline.
  showPlates(plates: { mesh: MeshData; x: number; y: number; alt: boolean }[], drawer: [number, number], h: number): void {
    this.clear();
    for (const p of plates) {
      const mesh = new THREE.Mesh(toGeometry(p.mesh), this.plateMaterials[Number(p.alt)]);
      mesh.position.set(p.x, p.y, 0);
      this.group.add(mesh);
    }
    const [w, d] = drawer;
    const outline = new THREE.BufferGeometry().setFromPoints(
      [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, y]) => new THREE.Vector3(x, y, 0.05)),
    );
    this.group.add(new THREE.LineLoop(outline, this.outlineMaterial));

    const sizeKey = `drawer:${w}x${d}x${h}`;
    if (sizeKey !== this.lastSize) {
      this.removeGrid();
      this.frame(w, d, h);
      this.lastSize = sizeKey;
    }
  }

  frame(w: number, d: number, h: number): void {
    const radius = Math.hypot(w, d, h) / 2;
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.1;
    this.controls.target.set(0, 0, h / 2);
    this.camera.position.set(dist * 0.55, -dist * 0.7, h / 2 + dist * 0.5);
    this.camera.near = dist / 100;
    this.camera.far = dist * 10;
    this.camera.updateProjectionMatrix();
  }

  private removeGrid(): void {
    if (!this.grid) return;
    this.grid.geometry.dispose();
    this.scene.remove(this.grid);
    this.grid = null;
  }

  private updateGrid(gridX: number, gridY: number): void {
    this.removeGrid();
    const n = Math.max(gridX, gridY) + 4;
    const color = getComputedStyle(document.documentElement).getPropertyValue('--grid').trim() || '#c8cdd3';
    this.grid = new THREE.GridHelper(n * GRID, n, color, color);
    this.grid.rotation.x = Math.PI / 2;
    // Align grid lines with the cell boundaries of the bin.
    const shift = (cells: number) => (n % 2 === cells % 2 ? 0 : GRID / 2);
    this.grid.position.set(shift(gridX), shift(gridY), -0.05);
    this.scene.add(this.grid);
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

function toGeometry(mesh: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  const flat = geometry.toNonIndexed();
  geometry.dispose();
  flat.computeVertexNormals();
  return flat;
}
