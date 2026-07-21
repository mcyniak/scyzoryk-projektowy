const http = require('http');
const checks = [
  { port: 3000, path: '/api/apps' },
  { port: 3001, path: '/api/status' },
  { port: 3002, path: '/api/health' },
  { port: 3003, path: '/api/version' },
  { port: 3004, path: '/api/health' },
  { port: 3005, path: '/api/health' },
  { port: 3011, path: '/api/health' }
];
function get(port, path) { return new Promise(resolve => { const req = http.get({ hostname: '127.0.0.1', port, path, timeout: 1500 }, res => { res.resume(); resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, statusCode: res.statusCode }); }); req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); }); req.on('error', err => resolve({ ok: false, error: err.message })); }); }
function postWithoutHeader() { return new Promise(resolve => { const body = '{}'; const req = http.request({ hostname: '127.0.0.1', port: 3001, path: '/api/clear', method: 'POST', timeout: 1500, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { res.resume(); resolve(res.statusCode === 403); }); req.on('timeout', () => { req.destroy(); resolve(false); }); req.on('error', () => resolve(false)); req.end(body); }); }
(async () => { let failed = 0; for (const check of checks) { const result = await get(check.port, check.path); if (result.ok) console.log(`OK  http://127.0.0.1:${check.port}${check.path}`); else { failed++; console.error(`ERR http://127.0.0.1:${check.port}${check.path}: ${result.error || result.statusCode}`); } } const protectedMutation = await postWithoutHeader(); if (protectedMutation) console.log('OK  POST bez naglowka ochronnego jest blokowany.'); else { failed++; console.error('ERR POST bez naglowka ochronnego nie zostal zablokowany.'); } if (failed) process.exit(1); console.log('\nSmoke test bezpieczenstwa OK.'); })();
