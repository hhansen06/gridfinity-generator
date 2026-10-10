// A screw type bundles head shape, drive and norm, so one pick sets all three.
export interface ScrewType {
  id: string;
  name: string;
  // Short designation that can go on the label as a second line.
  norm: string;
  head: string;
  drive: string;
}

const preset = (id: string, name: string, norm: string, head: string, drive: string): ScrewType => ({
  id,
  name,
  norm,
  head,
  drive,
});

export const SCREW_PRESETS: ScrewType[] = [
  preset('iso4762', 'Zylinderkopf Innensechskant', 'ISO 4762 / DIN 912', 'socket', 'hex'),
  preset('iso14579', 'Zylinderkopf Torx', 'ISO 14579', 'socket', 'torx'),
  preset('iso1207', 'Zylinderkopf Schlitz', 'ISO 1207 / DIN 84', 'socket', 'slot'),
  preset('iso10642', 'Senkkopf Innensechskant', 'ISO 10642 / DIN 7991', 'flat', 'hex'),
  preset('iso14581', 'Senkkopf Torx', 'ISO 14581', 'flat', 'torx'),
  preset('iso7046', 'Senkkopf Kreuzschlitz', 'ISO 7046 / DIN 965', 'flat', 'phillips'),
  preset('iso2009', 'Senkkopf Schlitz', 'ISO 2009 / DIN 963', 'flat', 'slot'),
  preset('iso7047', 'Linsensenkkopf Kreuzschlitz', 'ISO 7047 / DIN 966', 'oval', 'phillips'),
  preset('iso7380', 'Linsenkopf Innensechskant', 'ISO 7380', 'button', 'hex'),
  preset('iso14583', 'Flachkopf Torx', 'ISO 14583', 'pan', 'torx'),
  preset('iso7045', 'Flachkopf Kreuzschlitz', 'ISO 7045 / DIN 7985', 'pan', 'phillips'),
  preset('iso1580', 'Flachkopf Schlitz', 'ISO 1580 / DIN 85', 'pan', 'slot'),
  preset('iso7049', 'Blechschraube Linsenkopf', 'ISO 7049 / DIN 7981', 'pan', 'phillips'),
  preset('chipboard', 'Spanplattenschraube Senkkopf', '', 'flat', 'pozidriv'),
  preset('iso4017', 'Sechskantschraube', 'ISO 4017 / DIN 933', 'hex-head', ''),
  preset('din6921', 'Sechskant mit Flansch', 'DIN 6921', 'hex-washer', ''),
  preset('din46228', 'Aderendhülse', 'DIN 46228', 'ferrule', ''),
];

export const CUSTOM_PREFIX = 'custom-';
const STORAGE_KEY = 'gridfinity-screw-types-v1';

export function loadCustomTypes(): ScrewType[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ScrewType[]) : [];
  } catch {
    return [];
  }
}

export function saveCustomTypes(types: ScrewType[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(types));
  } catch {
    // Storage is optional; the types still work for this session.
  }
}

export const screwTypeLabel = (t: ScrewType) => (t.norm ? `${t.name} (${t.norm})` : t.name);
