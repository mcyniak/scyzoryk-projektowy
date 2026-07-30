const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function checkHealth(port, expectedName) {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch {}
        resolve(res.statusCode === 200 && payload?.ok === true && payload?.name === expectedName);
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function main() {
  const appDir = path.resolve(process.argv[2] || '');
  const expectedName = String(process.argv[3] || '');
  if (!fs.existsSync(path.join(appDir, 'server.js')) || !expectedName) {
    throw new Error('Uzycie: node verify-app-health.js <appDir> <expectedName>');
  }

  const port = await reservePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-health-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: appDir,
    env: {
      ...process.env,
      PORT: String(port),
      SCYZORYK_HOST: '127.0.0.1',
      SCYZORYK_DATA_ROOT: dataRoot
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { output += chunk.toString('utf8'); });

  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`Proces ${expectedName} zakonczyl sie kodem ${child.exitCode}.\n${output}`);
      }
      if (await checkHealth(port, expectedName)) {
        console.log(`Health-check OK: ${expectedName}`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Brak poprawnej odpowiedzi /api/health dla ${expectedName}.\n${output}`);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exit(1);
});
