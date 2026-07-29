// Uzywany WYLACZNIE przez workflow testu czystej instalacji
// (.github/workflows/clean-install-test.yml). Odpalany bundlowanym node z katalogu
// apps/formularze-ecodan (jedyna apka z zainstalowanym Playwright), zeby zweryfikowac,
// ze kazda strona narzedzia FAKTYCZNIE sie renderuje w przegladarce (nie tylko
// odpowiada na HTTP health-check) i zeby zrobic zrzut ekranu jako dowod w artefaktach CI.
//
// Uzycie: node screenshot-all.js <folder-wyjsciowy> <plik-json-z-lista-celow>
// Plik JSON: [{"slug":"panel","url":"http://127.0.0.1:3000/"}, ...]
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const outDir = process.argv[2];
const targetsPath = process.argv[3];
if (!outDir || !targetsPath) {
  console.error('Uzycie: node screenshot-all.js <folder-wyjsciowy> <plik-json-z-lista-celow>');
  process.exit(1);
}
const targets = JSON.parse(fs.readFileSync(targetsPath, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  let failed = 0;
  for (const t of targets) {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push(String(err)));
    try {
      const resp = await page.goto(t.url, { waitUntil: 'networkidle', timeout: 20000 });
      await page.screenshot({ path: path.join(outDir, `${t.slug}.png`), fullPage: true });
      const status = resp ? resp.status() : null;
      if (!status || status >= 400) throw new Error(`HTTP ${status}`);
      if (consoleErrors.length) {
        console.warn(`[${t.slug}] Bledy konsoli (nie przerywaja testu): ${consoleErrors.join(' | ')}`);
      }
      console.log(`OK   ${t.slug} (${t.url}) status=${status}`);
    } catch (err) {
      failed += 1;
      console.error(`BLAD ${t.slug} (${t.url}): ${err.message}`);
      try { await page.screenshot({ path: path.join(outDir, `${t.slug}-BLAD.png`), fullPage: true }); } catch (_) {}
    } finally {
      await page.close();
    }
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
