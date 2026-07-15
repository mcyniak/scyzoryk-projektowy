const fmtMb = bytes => `${Math.round((bytes || 0) / 1024 / 1024)} MB`;
const fmtSec = sec => {
  const s = Number(sec || 0);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const fmtTime = ts => {
  if (!ts) return 'brak';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? 'brak' : d.toLocaleString('pl-PL');
};
function setText(selector, value) {
  const el = document.querySelector(selector);
  if (el) el.textContent = value;
}
function queueText(app) {
  const q = app.queue;
  if (!q) return 'brak danych';
  const queued = q.queued ?? q.pending ?? 0;
  const active = q.active ? 'aktywne' : 'brak aktywnego';
  return `${queued} w kolejce, ${active}`;
}
function statusBadge(ok, warmup) {
  const cls = ok ? 'admin-ok' : (warmup ? 'admin-warn' : 'admin-bad');
  const text = ok ? 'działa' : (warmup ? 'uruchamianie' : 'problem');
  return `<span class="admin-status ${cls}">${text}</span>`;
}
function renderApps(apps) {
  const body = document.querySelector('#appsBody');
  if (!body) return;
  if (!apps.length) {
    body.innerHTML = '<tr><td colspan="7">Brak danych.</td></tr>';
    return;
  }
  body.innerHTML = apps.map(app => {
    const child = app.child || {};
    const processText = app.processAlive ? 'żywy' : 'martwy';
    const last = child.lastExit ? `ostatnio: ${fmtTime(child.lastExit.at)}` : 'brak ostatniego wyjścia';
    const ms = app.health?.ms != null ? `${app.health.ms} ms` : 'brak';
    return `<tr>
      <td><strong>${app.name}</strong><br><small>${app.description || ''}</small></td>
      <td>${statusBadge(app.running, app.processAlive && !app.running)}</td>
      <td>${processText}<br><small>${last}</small></td>
      <td>${queueText(app)}</td>
      <td>${child.restarts || 0}<br><small>błędy: ${child.failures || 0}</small></td>
      <td>${ms}<br><small>${app.health?.statusCode || app.health?.error || ''}</small></td>
      <td><a href="${app.url}">otwórz</a></td>
    </tr>`;
  }).join('');
}
async function refreshAdmin() {
  try {
    const response = await fetch('/api/apps', { cache: 'no-store' });
    const data = await response.json();
    const apps = data.apps || [];
    setText('#metricServices', `${apps.filter(a => a.running).length}/${apps.length}`);
    setText('#metricMemory', fmtMb(data.memory?.rss || 0));
    setText('#metricStorage', fmtMb(data.storage?.bytes || 0));
    setText('#metricUptime', fmtSec(data.uptimeSec || 0));
    setText('#lastRefresh', `Ostatnie sprawdzenie: ${new Date().toLocaleTimeString('pl-PL')}`);
    renderApps(apps);
  } catch (error) {
    setText('#lastRefresh', `Błąd odświeżania: ${error.message || error}`);
  }
  try {
    const logs = await fetch('/api/admin/logs', { cache: 'no-store' }).then(r => r.json());
    const box = document.querySelector('#logBox');
    if (box) box.textContent = logs.lines?.length ? logs.lines.join('\n') : 'Brak logów children.jsonl.';
  } catch (error) {
    const box = document.querySelector('#logBox');
    if (box) box.textContent = `Nie udało się pobrać logów: ${error.message || error}`;
  }
}
document.querySelector('#refreshBtn')?.addEventListener('click', refreshAdmin);
refreshAdmin();
setInterval(refreshAdmin, 10000);
