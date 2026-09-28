import type { ManifoldToplevel } from 'manifold-3d';

type Deletable = { delete(): void };

const garbage: Deletable[] = [];

// Manifold objects live on the WASM heap; every method result is tracked so it
// can be freed in one go after a model has been converted to plain arrays.
export function installGC(wasm: ManifoldToplevel): void {
  const classes = [wasm.Manifold, wasm.CrossSection] as unknown as (Function & Record<string, unknown>)[];
  const isTracked = (v: unknown) => classes.some((c) => v instanceof c);
  const track = (result: unknown) => {
    if (Array.isArray(result)) result.forEach(track);
    else if (isTracked(result)) garbage.push(result as Deletable);
    return result;
  };
  const wrap = (target: Record<string, unknown>) => {
    for (const name of Object.getOwnPropertyNames(target)) {
      if (name === 'constructor' || name === 'delete' || name === 'prototype') continue;
      const original = target[name];
      if (typeof original !== 'function') continue;
      target[name] = function (this: unknown, ...args: unknown[]) {
        return track((original as Function).apply(this, args));
      };
    }
  };
  for (const cls of classes) {
    wrap(cls);
    wrap(cls.prototype as Record<string, unknown>);
  }
}

export function collectGarbage(): void {
  for (const obj of garbage.splice(0)) obj.delete();
}
