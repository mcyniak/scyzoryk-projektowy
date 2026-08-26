const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { createTelemetryService } = require('../lib/telemetry');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

test('telemetria rejestruje instalacje raz, wysyla heartbeat i zdarzenie uzycia', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-telemetry-'));
  const token = 'A'.repeat(64);
  let registerCount = 0;
  let heartbeatCount = 0;
  let eventCount = 0;
  let receivedEvent = null;

  const server = http.createServer(async (req, res) => {
    const body = await readJson(req);

    if (req.url === '/v1/register') {
      registerCount += 1;
      res.writeHead(201, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        installation_id: body.installation_id,
        token
      }));
    }

    if (req.url === '/v1/heartbeat') {
      heartbeatCount += 1;
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, next_heartbeat_seconds: 300 }));
    }

    if (req.url === '/v1/event') {
      eventCount += 1;
      receivedEvent = body;
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }

    res.writeHead(404);
    res.end();
  });

  const port = await listen(server);

  try {
    const service = createTelemetryService({
      dataRoot: tempRoot,
      endpoint: `http://127.0.0.1:${port}`,
      getVersion: () => '1.2.2',
      timeoutMs: 2000
    });

    assert.equal(await service.runOnce(), true);
    assert.equal(await service.recordEvent({
      tool: 'tworzenie-folderow',
      eventType: 'completed',
      durationMs: 1234,
      estimatedManualMs: 600000,
      success: true
    }), true);

    assert.equal(registerCount, 1);
    assert.equal(heartbeatCount, 1);
    assert.equal(eventCount, 1);

    assert.match(receivedEvent.installation_id, /^scz-[a-f0-9]{32}$/);
    assert.deepEqual(
      {
        tool: receivedEvent.tool,
        event_type: receivedEvent.event_type,
        duration_ms: receivedEvent.duration_ms,
        estimated_manual_ms: receivedEvent.estimated_manual_ms,
        success: receivedEvent.success
      },
      {
        tool: 'tworzenie-folderow',
        event_type: 'completed',
        duration_ms: 1234,
        estimated_manual_ms: 600000,
        success: true
      }
    );
  } finally {
    await close(server);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('telemetria jest fail-open gdy monitor jest niedostepny', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-telemetry-fail-'));
  try {
    const service = createTelemetryService({
      dataRoot: tempRoot,
      endpoint: 'http://127.0.0.1:1',
      getVersion: () => '1.2.2',
      timeoutMs: 100
    });

    assert.equal(await service.runOnce(), false);
    assert.equal(await service.recordEvent({
      tool: 'panel',
      eventType: 'started'
    }), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('rownoczesny pierwszy start root + kilku apek-dzieci rejestruje TYLKO JEDNA instalacje (regresja na zywo: 1 realny install -> 19 "instalacji" w monitorze)', async () => {
  // Root server.js i kazda z apek-dzieci (dokumenty-seryjne, drukarka-projekty,
  // formularze-ecodan, formularze-varmero, nazywarka-skanow, tworzenie-folderow,
  // wnioski-powykonawcze) tworza WLASNA instancje createTelemetryService, ale
  // wszystkie wskazuja na ten sam dataRoot/statePath. Przy pierwszym starcie
  // (jednoczesnie, brak pliku stanu) kazda z nich probowala sie zarejestrowac
  // NIEZALEZNIE - bez blokady plikowej to jeden realny install rejestrowal
  // sie jako az 8 osobnych "instalacji" w monitorze.
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-telemetry-race-'));
  let registerCount = 0;
  const issuedIds = new Set();

  const server = http.createServer(async (req, res) => {
    const body = await readJson(req);
    if (req.url === '/v1/register') {
      registerCount += 1;
      issuedIds.add(body.installation_id);
      res.writeHead(201, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, installation_id: body.installation_id, token: 'B'.repeat(64) }));
    }
    if (req.url === '/v1/heartbeat') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, next_heartbeat_seconds: 300 }));
    }
    res.writeHead(404);
    res.end();
  });

  const port = await listen(server);
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    const processCount = 8; // root + 7 apek-dzieci ktore montuja telemetryService
    const services = Array.from({ length: processCount }, () => createTelemetryService({
      dataRoot: tempRoot,
      endpoint,
      getVersion: () => '1.3.1',
      timeoutMs: 2000
    }));

    // Symulacja rownoczesnego pierwszego uruchomienia wszystkich procesow -
    // kazdy woła runOnce() w tej samej chwili, zanim ktokolwiek zdazyl
    // cokolwiek zapisac na dysk.
    const results = await Promise.all(services.map(s => s.runOnce()));
    assert.ok(results.every(Boolean), 'kazdy proces powinien zakonczyc heartbeat sukcesem');

    assert.equal(registerCount, 1, `oczekiwano DOKLADNIE JEDNEJ rejestracji, zarejestrowano ${registerCount}`);
    assert.equal(issuedIds.size, 1);

    const states = services.map(s => s.getState());
    assert.ok(states.every(Boolean), 'kazdy proces musi w koncu widziec zapisany stan');
    const uniqueInstallationIds = new Set(states.map(s => s.installation_id));
    assert.equal(uniqueInstallationIds.size, 1, 'wszystkie procesy musza dzielic ten sam installation_id');
  } finally {
    await close(server);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
