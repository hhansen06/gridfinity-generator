import opentype, { type Font } from 'opentype.js';
import roboto from '@fontsource/roboto/files/roboto-latin-700-normal.woff?url';
import robotoSlab from '@fontsource/roboto-slab/files/roboto-slab-latin-700-normal.woff?url';
import robotoMono from '@fontsource/roboto-mono/files/roboto-mono-latin-700-normal.woff?url';
import bebas from '@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff?url';

const urls: Record<string, string> = {
  roboto,
  'roboto-slab': robotoSlab,
  'roboto-mono': robotoMono,
  bebas,
};

const cache = new Map<string, Promise<Font>>();

export function loadFont(id: string): Promise<Font> {
  let font = cache.get(id);
  if (!font) {
    font = fetch(urls[id] ?? urls.roboto)
      .then((r) => r.arrayBuffer())
      .then((buf) => opentype.parse(buf));
    cache.set(id, font);
  }
  return font;
}
