const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DEFAULT_ENDPOINT = 'https://scyzoryk-monitor.scyzoryk.workers.dev';
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_START_DELAY_MS = 5 * 1000;
const DEFAULT_TIMEOUT_MS = 5 * 1000;

const EVENT_TYPES = new Set(['started', 'completed', 'failed']);

function normalizeEndpoint(value) {
  const raw = String(value || '').trim();
  if (!raw) return DEFAULT_ENDPOINT;
  return raw.replace(/\/+$/, '');
}

function validInstallationId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(value);
}

function validToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,200}$/.test(value);
}

function validTool(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
}

function createInstallationId() {
  return `scz-${randomUUID().replace(/-/g, '')}`;
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function createTelemetryService(options = {}) {
  const enabled = options.enabled !== false;
  const endpoint = normalizeEndpoint(options.endpoint);
  const dataRoot = path.resolve(options.dataRoot || '.');
  const getVersion = typeof options.getVersion === 'function'
    ? options.getVersion
    : () => 'unknown';
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const heartbeatIntervalMs = Number(options.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS);
  const startDelayMs = Number(options.startDelayMs ?? DEFAULT_START_DELAY_MS);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const startedAt = new Date().toISOString();

  const telemetryDir = path.join(dataRoot, 'telemetry');
  const statePath = path.join(telemetryDir, 'installation.json');

  let started = false;
  let startTimer = null;
  let heartbeatTimer = null;

  function readState() {
    try {
      const parsed = safeJsonParse(fs.readFileSync(statePath, 'utf8'));
      if (!parsed || !validInstallationId(parsed.installation_id) || !validToken(parsed.token)) {
        return null;
      }
      return {
        installation_id: parsed.installation_id,
        token: parsed.token
      };
    } catch {
      return null;
    }
  }

  function writeState(state) {
    fs.mkdirSync(telemetryDir, { recursive: true });
    const tmp = `${statePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify({
      installation_id: state.installation_id,
      token: state.token,
      registered_at: new Date().toISOString()
    }, null, 2), { encoding: 'utf8', mode: 0o600 });

    try {
      fs.renameSync(tmp, statePath);
    } catch (error) {
      if (error && (error.code === 'EEXIST' || error.code === 'EPERM')) {
        fs.rmSync(statePath, { force: true });
        fs.renameSync(tmp, statePath);
      } else {
        try { fs.rmSync(tmp, { force: true }); } catch {}
        throw error;
      }
    }
  }

  function clearState() {
    try { fs.rmSync(statePath, { force: true }); } catch {}
  }

  async function requestJson(pathname, { method = 'POST', token = null, body = null } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('telemetry_fetch_unavailable');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    try {
      const headers = { 'content-type': 'application/json' };
      if (token) headers.authorization = `Bearer ${token}`;

      const response = await fetchImpl(`${endpoint}${pathname}`, {
        method,
        headers,
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal
      });

      const text = await response.text();
      const payload = text ? safeJsonParse(text) : null;
      return { status: response.status, ok: response.ok, payload };
    } finally {
      clearTimeout(timer);
    }
  }

  async function registerNewIdentity() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const installationId = createInstallationId();
      const version = String(getVersion() || 'unknown');

      const result = await requestJson('/v1/register', {
        body: {
          installation_id: installationId,
          version,
          started_at: startedAt
        }
      });

      if (
        result.status === 201 &&
        result.payload?.ok === true &&
        result.payload.installation_id === installationId &&
        validToken(result.payload.token)
      ) {
        const state = { installation_id: installationId, token: result.payload.token };
        writeState(state);
        return state;
      }

      if (result.status !== 409) {
        throw new Error(`telemetry_register_http_${result.status}`);
      }
    }

    throw new Error('telemetry_register_conflict');
  }

  async function ensureRegistered() {
    return readState() || registerNewIdentity();
  }

  async function authenticatedPost(pathname, body) {
    let state = await ensureRegistered();
    let result = await requestJson(pathname, {
      token: state.token,
      body: { installation_id: state.installation_id, ...body }
    });

    if (result.status === 401) {
      clearState();
      state = await registerNewIdentity();
      result = await requestJson(pathname, {
        token: state.token,
        body: { installation_id: state.installation_id, ...body }
      });
    }

    return result;
  }

  async function runOnceInternal() {
    const result = await authenticatedPost('/v1/heartbeat', {
      version: String(getVersion() || 'unknown'),
      started_at: startedAt,
      uptime_seconds: Math.max(0, Math.round(process.uptime()))
    });

    if (!result.ok || result.payload?.ok !== true) {
      throw new Error(`telemetry_heartbeat_http_${result.status}`);
    }

    return true;
  }

  async function runOnce() {
    if (!enabled) return false;
    try {
      return await runOnceInternal();
    } catch {
      // Fail-open: telemetria nigdy nie moze zatrzymac Scyzoryka.
      return false;
    }
  }

  async function recordEvent(event = {}) {
    if (!enabled) return false;

    const tool = String(event.tool || '').trim();
    const eventType = String(event.eventType || '').trim();

    if (!validTool(tool) || !EVENT_TYPES.has(eventType)) return false;

    const body = {
      tool,
      event_type: eventType
    };

    if (Number.isFinite(event.durationMs) && event.durationMs >= 0) {
      body.duration_ms = Math.round(event.durationMs);
    }
    if (Number.isFinite(event.estimatedManualMs) && event.estimatedManualMs >= 0) {
      body.estimated_manual_ms = Math.round(event.estimatedManualMs);
    }
    if (typeof event.success === 'boolean') {
      body.success = event.success;
    }
    if (event.errorCode != null) {
      body.error_code = String(event.errorCode).trim().slice(0, 80);
    }

    try {
      const result = await authenticatedPost('/v1/event', body);
      return Boolean(result.ok && result.payload?.ok === true);
    } catch {
      return false;
    }
  }

  function start() {
    if (!enabled || started) return false;
    started = true;

    startTimer = setTimeout(() => {
      runOnce();
      heartbeatTimer = setInterval(runOnce, heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    }, Math.max(0, startDelayMs));

    startTimer.unref?.();
    return true;
  }

  function stop() {
    if (startTimer) clearTimeout(startTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    startTimer = null;
    heartbeatTimer = null;
    started = false;
  }

  return {
    start,
    stop,
    runOnce,
    recordEvent,
    getStatePath: () => statePath,
    getState: readState
  };
}

module.exports = {
  createTelemetryService,
  createInstallationId,
  normalizeEndpoint,
  validInstallationId,
  validToken,
  validTool
};
