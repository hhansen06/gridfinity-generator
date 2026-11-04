# Dateiformat `.gfkontur` (Version 1)

Eine `.gfkontur`-Datei speichert eine Konturbox editierbar: Konturen, Ausschnitte, Texte, Einstellungen und optional das entzerrte Foto. Sie ist UTF-8-kodiertes JSON und lässt sich mit jedem Texteditor lesen und ändern.

## Koordinaten

- Einheit: Millimeter.
- Bezugssystem ist das DIN-A4-Blatt hochkant: Ursprung oben links, **x nach rechts, y nach unten**, Blatt 210 × 297 mm. Werte außerhalb des Blatts sind erlaubt (−1000 … 1000).
- Winkel in Grad, **im Uhrzeigersinn** (wie auf dem Bildschirm), −180 … 180.
- Die Box selbst wird nicht gespeichert, sondern beim Öffnen neu berechnet: zentriert um alle Elemente, gedreht um `settings.rotation`.

## Aufbau

```json
{
 "format": "gridfinity-kontur",
 "version": 1,
 "unit": "mm",
 "sheet": { "width": 210, "height": 297 },
 "settings": {
  "clearance": 1,
  "depth": 15,
  "rotation": 0,
  "grid": { "x": "auto", "y": 3, "z": "auto" },
  "lip": true,
  "magnets": false,
  "colorFloor": true,
  "sensitivity": 50,
  "colors": { "body": "#9aa3ad", "accent": "#f28c28" }
 },
 "contours": [
  { "depth": null, "points": [[60, 100], [140, 100], [140, 130], [60, 130]] }
 ],
 "cutouts": [
  { "type": "circle", "x": 80, "y": 160, "diameter": 22.5, "depth": 15 },
  { "type": "rect", "x": 120, "y": 160, "width": 30, "height": 20, "angle": 0, "depth": 10 },
  { "type": "grip", "x": 140, "y": 115, "length": 30, "width": 20, "angle": 0, "depth": 15 },
  { "type": "text", "x": 100, "y": 185, "text": "Knarre 1/4\"", "font": "roboto", "height": 6, "angle": 0, "finish": "inlay" }
 ],
 "photo": null
}
```

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `format` | ja | immer `"gridfinity-kontur"` |
| `version` | ja | Formatversion; Leser lehnen höhere Versionen ab |
| `unit` | nein | immer `"mm"` |
| `sheet` | nein | Blattgröße, informativ (immer 210 × 297) |
| `photo` | nein | entzerrtes Foto des Blatts als Data-URL (`data:image/jpeg;base64,…`, auch PNG/WebP) oder `null` |

### `settings`

Alle Felder sind optional; fehlende bekommen den Standardwert.

| Feld | Standard | Bedeutung |
|---|---|---|
| `clearance` | 1 | Abstand der Aussparung zum Gegenstand (0 … 5 mm) |
| `depth` | 15 | Tiefe der Aussparungen (1 … 160 mm) |
| `rotation` | 0 | Drehung des Inhalts in der Box, Grad gegen den Uhrzeigersinn |
| `grid.x`, `grid.y` | `"auto"` | Boxgröße in Rastereinheiten (42 mm, 1 … 10) oder `"auto"` |
| `grid.z` | `"auto"` | Höhe in 7-mm-Einheiten (1 … 25) oder `"auto"` |
| `lip` | `true` | Stapelrand |
| `magnets` | `false` | Magnetlöcher |
| `colorFloor` | `false` | Boden der Aussparungen 0,6 mm in der Zweitfarbe |
| `sensitivity` | 50 | Empfindlichkeit der Konturerkennung (0 … 100) |
| `colors.body`, `colors.accent` | grau, orange | Farben als `#rrggbb` |

### `contours`

Geschlossene Polygone (3 … 2000 Punkte), jeweils `[x, y]`. Der Abstand (`clearance`) wird beim Erzeugen hinzugerechnet; die Punkte beschreiben den Gegenstand selbst. `depth` ist eine eigene Tiefe in mm oder `null` für die globale Tiefe.

### `cutouts`

Jeder Eintrag hat `type`, Mittelpunkt `x`, `y` und je nach Typ:

| `type` | Felder |
|---|---|
| `circle` | `diameter`, `depth` |
| `rect` | `width`, `height`, `angle`, `depth` |
| `grip` | Fingergriff (Kapsel mit rundem Boden): `length`, `width`, `angle`, `depth` |
| `text` | `text` (max. 200 Zeichen, `\n` für Zeilenumbruch), `font` (`roboto`, `roboto-slab`, `roboto-mono`, `bebas`), `height` (Schrifthöhe in mm), `angle`, `finish` (`inlay` = bündig in der Zweitfarbe, `engraved` = graviert) |

Fehlt `depth`, gilt `settings.depth`; fehlt `angle`, gilt 0. Größen liegen zwischen 1 und 500 mm.

## Grenzen

Höchstens 200 Konturen und 500 Ausschnitte; die Datei darf 20 MB nicht überschreiten. Ungültige Dateien werden mit einer Meldung abgelehnt, die das fehlerhafte Feld nennt (z. B. `cutouts[2].diameter: Zahl erwartet.`).
