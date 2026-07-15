const cards = new Map([...document.querySelectorAll('.tool-card')].map(card => [card.dataset.app, card]));
const fmtMb = bytes => `${Math.round((bytes || 0) / 1024 / 1024)} MB`;
function fmtTime(ts) {
  if (!ts) return 'brak';
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? 'brak' : date.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
}
function appMeta(app) {
  const bits = [];
  bits.push(app.processAlive ? 'proces żywy' : 'proces martwy');
  if (app.queue) bits.push(`kolejka: ${app.queue.queued || 0}${app.queue.active ? ' + aktywne' : ''}`);
  if (app.child?.restarts) bits.push(`restarty: ${app.child.restarts}`);
  if (app.child?.lastExit) bits.push(`ostatnie wyjście: ${fmtTime(app.child.lastExit.at)}`);
  if (app.health?.ms != null) bits.push(`${app.health.ms} ms`);
  return bits.join(' • ');
}
function setText(selector, value) {
  const el = document.querySelector(selector);
  if (el) el.textContent = value;
}
async function refreshStatus() {
  try {
    const response = await fetch('/api/apps', { cache: 'no-store' });
    const data = await response.json();
    const apps = data.apps || [];
    const running = apps.filter(a => a.running).length;
    setText('#metricServices', `${running}/${apps.length}`);
    setText('#metricMemory', fmtMb(data.memory?.rss || 0));
    setText('#metricStorage', fmtMb(data.storage?.bytes || 0));
    setText('#metricMode', data.host === '127.0.0.1' ? 'Lokalny' : data.host);
    setText('#lastRefresh', `Ostatnie sprawdzenie: ${new Date().toLocaleTimeString('pl-PL')}`);
    for (const app of apps) {
      const card = cards.get(app.slug);
      if (!card) continue;
      const badge = card.querySelector('.badge');
      const link = card.querySelector('a.button-link');
      const meta = card.querySelector('.card-meta');
      if (link && app.url) link.href = app.url;
      card.classList.toggle('disabled', !app.running);
      card.classList.toggle('warn', Boolean(app.processAlive && !app.running));
      if (badge) {
        badge.textContent = app.running ? 'gotowe' : (app.processAlive ? 'uruchamianie' : 'restart');
        badge.classList.toggle('online', Boolean(app.running));
        badge.classList.toggle('offline', !app.running);
      }
      if (meta) meta.textContent = appMeta(app);
    }
  } catch (error) {
    setText('#lastRefresh', 'Nie udało się sprawdzić statusu.');
    for (const card of cards.values()) {
      const badge = card.querySelector('.badge');
      if (!badge) continue;
      badge.textContent = 'niedostępne';
      badge.classList.add('offline');
    }
  }
}
document.querySelector('#refreshBtn')?.addEventListener('click', refreshStatus);
refreshStatus();
setInterval(refreshStatus, 10000);


// Otwieranie sekcji Pomoc po kliknięciu przycisku w górnym panelu.
document.querySelector('#helpTopLink')?.addEventListener('click', () => {
  const panel = document.querySelector('#supportPanel');
  if (panel) panel.open = true;
});


// Modal Pomocy (zamiast stalej sekcji na dole strony)
(function () {
  const overlay = document.getElementById('helpModalOverlay');
  const openBtn = document.getElementById('helpTopLink');
  const closeBtn = document.getElementById('helpModalClose');
  if (!overlay || !openBtn) return;
  function openModal() { overlay.classList.add('open'); }
  function closeModal() { overlay.classList.remove('open'); }
  openBtn.addEventListener('click', openModal);
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay.classList.contains('open')) closeModal(); });
})();
