const http = require('http');

const checks = [
  { port: Number(process.env.PORT || 3000), path: '/api/apps' },
  { port: Number(process.env.DRUKARKA_PORT || 3001), path: '/api/health', name: 'drukarka' },
  { port: Number(process.env.PIECZATKI_PORT || 3002), path: '/api/health', name: 'pieczatki-pdf' },
  { port: Number(process.env.FORMULARZE_PORT || 3003), path: '/api/health', name: 'formularze-ecodan' },
  { port: Number(process.env.SERYJNE_PORT || 3004), path: '/api/health', name: 'dokumenty-seryjne' },
  { port: Number(process.env.WNIOSKI_PORT || 3005), path: '/api/health', name: 'wnioski-powykonawcze' },
  { port: Number(process.env.KARTY_PORT || 3006), path: '/api/health', name: 'karty-katalogowe' },
  { port: Number(process.env.DRUKARKA_PROJEKTY_PORT || 3010), path: '/api/health', name: 'drukarka-projekty' },
  { port: Number(process.env.OCR_AUDYTOW_PORT || 3011), path: '/api/health', name: 'ocr-audytow' }
];

function get(port, path, expectedName) {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port, path, timeout: 1500 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch {}
        const ok = res.statusCode === 200
          && payload?.ok === true
          && (!expectedName || payload?.name === expectedName);
        resolve({ ok, statusCode: res.statusCode, payload });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', err => resolve({ ok: false, error: err.message }));
  });
}

// Audyt zuzycia RAM 2026-08-21 (lazy-start): apki-dzieci JUZ NIE startuja
// automatycznie przy starcie Scyzoryka - bez tego kroku kazdy ponizszy
// health-check zawiodlby po cichu (apka po prostu nigdy by nie wstala),
// tak jakby to byl prawdziwy problem bezpieczenstwa/dostepnosci. Prosimy
// panel o start kazdej apki (idempotentne) i czekamy, az realnie odpowie,
// zanim faktyczny smoke test zacznie cokolwiek sprawdzac.
function startApp(panelPort, slug) {
  return new Promise(resolve => {
    const req = http.request({
      hostname: '127.0.0.1', port: panelPort, path: `/api/apps/${slug}/start`, method: 'POST', timeout: 3000,
      headers: { 'X-Scyzoryk-Request': '1', 'Content-Length': 0 }
    }, res => { res.resume(); resolve(); });
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.on('error', () => resolve());
    req.end();
  });
}

async function ensureAppsStarted(panelPort) {
  for (const check of checks) {
    if (!check.name) continue; // pierwszy wpis to sam panel, nie ma go co startowac
    await startApp(panelPort, check.name);
  }
  const deadline = Date.now() + 60000;
  for (const check of checks) {
    if (!check.name) continue;
    while (Date.now() < deadline) {
      const result = await get(check.port, check.path, check.name);
      if (result.ok) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

function postWithoutHeader() {
  return new Promise(resolve => {
    const body = '{}';
    const req = http.request({
      hostname: '127.0.0.1',
      port: Number(process.env.DRUKARKA_PORT || 3001),
      path: '/api/clear',
      method: 'POST',
      timeout: 1500,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      res.resume();
      resolve(res.statusCode === 403);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end(body);
  });
}

(async () => {
  await ensureAppsStarted(checks[0].port);

  let failed = 0;
  for (const check of checks) {
    const result = await get(check.port, check.path, check.name);
    if (result.ok) {
      console.log(`OK  http://127.0.0.1:${check.port}${check.path}`);
    } else {
      failed++;
      console.error(`ERR http://127.0.0.1:${check.port}${check.path}: ${result.error || result.statusCode}`);
    }
  }

  const protectedMutation = await postWithoutHeader();
  if (protectedMutation) {
    console.log('OK  POST bez naglowka ochronnego jest blokowany.');
  } else {
    failed++;
    console.error('ERR POST bez naglowka ochronnego nie zostal zablokowany.');
  }

  if (failed) process.exit(1);
  console.log('\nSmoke test bezpieczenstwa OK.');
})();
