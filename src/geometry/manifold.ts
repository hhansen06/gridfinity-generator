import Module, { type ManifoldToplevel } from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { installGC } from './gc';

let instance: Promise<ManifoldToplevel> | null = null;

export function loadManifold(): Promise<ManifoldToplevel> {
  instance ??= Module({ locateFile: () => wasmUrl }).then((wasm) => {
    wasm.setup();
    installGC(wasm);
    return wasm;
  });
  return instance;
}
