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
