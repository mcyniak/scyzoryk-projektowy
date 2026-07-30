const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const test = require('node:test');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function request(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: requestPath, timeout: 3000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function fakeHealth(statusCode, payload) {
  return http.createServer((req, res) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  });
}

async function waitForPanel(port, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Panel zakonczyl sie kodem ${child.exitCode}.`);
    try {
      const response = await request(port, '/');
      if (response.statusCode === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Panel nie uruchomil sie w wymaganym czasie.');
}

test('panel usuwa trasy admina i uznaje tylko poprawny kontrakt health', async t => {
  const healthy = fakeHealth(200, { ok: true, name: 'drukarka' });
  const forbidden = fakeHealth(403, {});
  const falseOk = fakeHealth(200, { ok: false, name: 'formularze-ecodan' });
  const wrongName = fakeHealth(200, { ok: true, name: 'inny-modul' });
  const servers = [healthy, forbidden, falseOk, wrongName];
  const ports = await Promise.all(servers.map(listen));
  t.after(async () => { await Promise.all(servers.map(close)); });

  const closedProbe = http.createServer();
  const closedPort = await listen(closedProbe);
  await close(closedProbe);

  const panelProbe = http.createServer();
  const panelPort = await listen(panelProbe);
  await close(panelProbe);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-panel-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const root = path.resolve(__dirname, '..');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(panelPort),
      LOCALAPPDATA: tempRoot,
      SCYZORYK_SKIP_AUTO_INSTALL: '1',
      SCYZORYK_SKIP_CHILD_START: '1',
      SCYZORYK_SKIP_DATA_MIGRATION: '1',
      DRUKARKA_PORT: String(ports[0]),
      PIECZATKI_PORT: String(ports[1]),
      FORMULARZE_PORT: String(ports[2]),
      SERYJNE_PORT: String(ports[3]),
      WNIOSKI_PORT: String(closedPort),
      KARTY_PORT: String(closedPort),
      DRUKARKA_PROJEKTY_PORT: String(closedPort),
      OCR_AUDYTOW_PORT: String(closedPort)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { output += chunk.toString('utf8'); });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });

  await waitForPanel(panelPort, child);

  assert.equal((await request(panelPort, '/admin')).statusCode, 404);
  assert.equal((await request(panelPort, '/admin.html')).statusCode, 404);
  assert.equal((await request(panelPort, '/api/admin/logs')).statusCode, 404);
  assert.equal((await request(panelPort, '/')).statusCode, 200);

  const appsResponse = await request(panelPort, '/api/apps');
  assert.equal(appsResponse.statusCode, 200, output);
  const payload = JSON.parse(appsResponse.body);
  const bySlug = new Map(payload.apps.map(app => [app.slug, app]));
  assert.equal(bySlug.get('drukarka').health.ok, true);
  assert.equal(bySlug.get('pieczatki-pdf').health.ok, false);
  assert.equal(bySlug.get('formularze-ecodan').health.ok, false);
  assert.equal(bySlug.get('dokumenty-seryjne').health.ok, false);
});
