# Gridfinity Generator

Webbasierter Generator für [Gridfinity](https://gridfinity.xyz)-Boxen. Läuft komplett im Browser – kein Backend, kein Login.

- Größe in Rastereinheiten: X/Y (42 mm), Z (7 mm)
- Stapelrand und Magnetlöcher (6×2 mm) optional
- Beschriftungslasche mit Text (mehrzeilig, 4 Schriftarten), Schraubensymbolen (10 Kopfformen, 13 Antriebe) und eigenem Logo (SVG, PNG, JPG), erhaben, graviert oder bündig eingelegt
- 3D-Vorschau, Download als STL oder als 3MF mit Farben (Box und Schrift als getrennte Teile, in Bambu Studio/OrcaSlicer direkt Filament 1 und 2 zugeordnet)
- Stapelliste: mehrere Boxen sammeln (auch zeilenweise per Textfeld) und zusammen als eine 3MF-Datei herunterladen

## Entwicklung

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # statische Seite in dist/
```

`dist/` kann auf jedem statischen Webserver liegen (relative Pfade, `.wasm` braucht den MIME-Type `application/wasm`).

## Docker

```sh
docker compose up -d --build     # http://localhost:8080
```

Anderer Port: `GRIDFINITY_PORT=9000 docker compose up -d --build`. Der Container baut die App und liefert sie über nginx (ohne Root-Rechte, schreibgeschützt) mit denselben Security-Headern wie das AWS-Hosting aus.

Hosting auf AWS (S3 + CloudFront, Deployment per GitHub Actions): siehe [`infra/README.md`](infra/README.md).

## Aufbau

| Datei | Inhalt |
| --- | --- |
| `src/geometry/gridfinity.ts` | Box-Geometrie nach Gridfinity-Spezifikation (manifold-3d) |
| `src/geometry/text.ts` | Text → Polygone (opentype.js) |
| `src/logo.ts` | SVG- und Rasterlogo → Polygone |
| `src/symbols.ts` | Vordefinierte Symbole (Kopfformen, Antriebe) |
| `src/viewer.ts` | three.js-Vorschau |
| `src/stl.ts` | Binärer STL-Export |
| `src/threemf.ts` | 3MF-Export (mehrere Modelle, colorgroup + Bambu-Filamentzuordnung) |
| `src/main.ts` | Formular und Ablauf |

SVG-Logos: dunkle Füllflächen werden massiv, helle (weiße) Flächen darüber schneiden Löcher. Reine Konturlinien werden nicht unterstützt.
