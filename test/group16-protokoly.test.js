// Testy narzedzia "Zdjecia do PDF Protokolow" (apps/protokoly) - w
// szczegolnosci regresja dla realnej skargi "zdjecia drukuja sie czarne":
// audyt na zywo 2026-08-17 wykazal empirycznie, ze stary img.normalize()
// (rozciaganie histogramu na podstawie surowego min/max) lapal sie na
// ostrym blasku/odbiciu lampy blyskowej telefonu jako falszywym punkcie
// bieli - dla niedoswietlonej kartki z takim blaskiem koncowa srednia
// jasnosc spadala do ~107/255 (ciemny wydruk), podczas gdy ta sama kartka
// bez blasku konczyla na ~235/255. Naprawa: applyPercentileLevels (rozciaganie
// oparte na percentylach histogramu) w apps/protokoly/src/protokolBuilder.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Jimp, JimpMime } = require('../apps/protokoly/node_modules/jimp');
const { applyPercentileLevels, processPhoto } = require('../apps/protokoly/src/protokolBuilder');

function meanLuminance(img) {
  const { width, height } = img.bitmap;
  let sum = 0, count = 0;
  img.scan(0, 0, width, height, function (x, y, idx) {
    const r = this.bitmap.data[idx], g = this.bitmap.data[idx + 1], b = this.bitmap.data[idx + 2];
    sum += 0.299 * r + 0.587 * g + 0.114 * b;
    count += 1;
  });
  return sum / count;
}

// Symuluje zdjecie kartki zrobione telefonem: ciemny blat/stol dookola,
// jasniejsza (ale przy niedoswietleniu wciaz stosunkowo ciemna) kartka ze
// "sladami tekstu", opcjonalnie z ostrym okraglym blaskiem od flesza w rogu
// (odbicie w laminacie/foli) - dokladnie ten przypadek z audytu 2026-08-17.
async function buildSyntheticPhoto({ paperGray, withGlare }) {
  const W = 1600, H = 2000;
  const padX = 250, padY = 300, pageW = W - 2 * padX, pageH = H - 2 * padY;
  const img = new Jimp({ width: W, height: H, color: 0x2a2a2aff });
  img.scan(padX, padY, pageW, pageH, function (x, y, idx) {
    this.bitmap.data[idx] = paperGray;
    this.bitmap.data[idx + 1] = paperGray;
    this.bitmap.data[idx + 2] = paperGray;
    this.bitmap.data[idx + 3] = 255;
  });
  for (let row = 0; row < 20; row += 1) {
    const y0 = padY + 100 + row * 80;
    if (y0 > H - padY - 40) break;
    img.scan(padX + 80, y0, pageW - 160, 10, function (x, y, idx) {
      this.bitmap.data[idx] = 25;
      this.bitmap.data[idx + 1] = 25;
      this.bitmap.data[idx + 2] = 25;
    });
  }
  if (withGlare) {
    const cx = padX + 200, cy = padY + 200, r = 110;
    img.scan(Math.max(0, cx - r), Math.max(0, cy - r), r * 2, r * 2, function (x, y, idx) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < r) {
        const falloff = 1 - d / r;
        const v = Math.min(255, this.bitmap.data[idx] + Math.round(255 * falloff));
        this.bitmap.data[idx] = v;
        this.bitmap.data[idx + 1] = v;
        this.bitmap.data[idx + 2] = v;
      }
    });
  }
  return img;
}

test('applyPercentileLevels: blask/odblask flesza nie psuje rozciagniecia reszty kartki (audyt 2026-08-17)', async () => {
  const img = await buildSyntheticPhoto({ paperGray: 130, withGlare: true });
  const cropped = img.clone().crop({ x: 250, y: 300, w: 1100, h: 1400 });
  applyPercentileLevels(cropped);
  const mean = meanLuminance(cropped);
  // Surowy min/max (stare zachowanie img.normalize()) dawal dla porownywalnego
  // obrazu ~107/255 - tu oczekujemy wyraznie jasnego wyniku, bezpiecznego do
  // druku czarno-bialego.
  assert.ok(mean > 180, `oczekiwano jasnej kartki (>180/255) po korekcie, otrzymano ${mean.toFixed(1)}`);
});

test('applyPercentileLevels: nie psuje juz dobrze doswietlonego zdjecia', async () => {
  const img = await buildSyntheticPhoto({ paperGray: 210, withGlare: false });
  const cropped = img.clone().crop({ x: 250, y: 300, w: 1100, h: 1400 });
  applyPercentileLevels(cropped);
  const mean = meanLuminance(cropped);
  assert.ok(mean > 180, `dobrze doswietlone zdjecie powinno zostac jasne, otrzymano ${mean.toFixed(1)}`);
});

test('processPhoto: niedoswietlona kartka z blaskiem flesza konczy pipeline jasna, nie czarna (audyt 2026-08-17)', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protokoly-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const img = await buildSyntheticPhoto({ paperGray: 130, withGlare: true });
  const filePath = path.join(tmpDir, 'zdjecie.jpg');
  fs.writeFileSync(filePath, await img.getBuffer(JimpMime.jpeg, { quality: 90 }));

  const processed = await processPhoto(filePath, {});
  const mean = meanLuminance(processed);
  assert.ok(mean > 180, `wynik processPhoto powinien byc jasny (>180/255) mimo blasku flesza, otrzymano ${mean.toFixed(1)}`);
});

test('processPhoto: niedoswietlona kartka BEZ blasku dalej wychodzi jasna (regresja istniejacej korekty cieni)', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protokoly-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const img = await buildSyntheticPhoto({ paperGray: 130, withGlare: false });
  const filePath = path.join(tmpDir, 'zdjecie.jpg');
  fs.writeFileSync(filePath, await img.getBuffer(JimpMime.jpeg, { quality: 90 }));

  const processed = await processPhoto(filePath, {});
  const mean = meanLuminance(processed);
  assert.ok(mean > 180, `wynik processPhoto powinien byc jasny (>180/255), otrzymano ${mean.toFixed(1)}`);
});
