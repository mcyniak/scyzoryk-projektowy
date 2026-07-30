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
  if (app.child?.circuitOpen) bits.push(`blokada restartów: ${app.child.circuitReason || 'wymagany restart Scyzoryka'}`);
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
    setText('#statOnline', String(running));
    setText('#statTotal', String(apps.length));
    for (const app of apps) {
      const card = cards.get(app.slug);
      if (!card) continue;
      const badge = card.querySelector('.badge');
      const link = card.querySelector('a.button-link');
      const meta = card.querySelector('.card-meta');
      if (link && app.url) link.href = app.url;
      card.classList.toggle('disabled', !app.running);
      card.classList.toggle('warn', Boolean((app.processAlive && !app.running) || app.child?.circuitOpen));
      if (badge) {
        badge.textContent = app.running ? 'gotowe' : (app.child?.circuitOpen ? 'awaria — uruchom ponownie Scyzoryka' : (app.processAlive ? 'uruchamianie' : 'restart'));
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

// Wyszukiwarka narzedzi: filtruje karty po nazwie i opisie, chowa puste
// kategorie, pokazuje stan pusty. Skrot "/" ustawia fokus na polu wyszukiwania,
// o ile uzytkownik nie pisze juz w innym formularzu.
(function () {
  const input = document.getElementById('toolSearchInput');
  const categories = [...document.querySelectorAll('.tool-category')];
  const cardsBySearch = [...document.querySelectorAll('.tool-card')];
  const emptyState = document.getElementById('toolSearchEmpty');
  const emptyQuery = document.getElementById('toolSearchEmptyQuery');
  if (!input) return;

  function normalize(text) {
    return String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  }

  function applyFilter() {
    const query = normalize(input.value.trim());
    let visibleTotal = 0;
    for (const category of categories) {
      let visibleInCategory = 0;
      for (const card of category.querySelectorAll('.tool-card')) {
        const haystack = normalize(card.querySelector('h3')?.textContent + ' ' + card.querySelector('p')?.textContent);
        const matches = !query || haystack.includes(query);
        card.classList.toggle('is-hidden-by-search', !matches);
        if (matches) visibleInCategory += 1;
      }
      category.classList.toggle('is-empty-by-search', visibleInCategory === 0);
      visibleTotal += visibleInCategory;
    }
    if (emptyState) {
      emptyState.classList.toggle('is-visible', query.length > 0 && visibleTotal === 0);
      if (emptyQuery) emptyQuery.textContent = input.value.trim();
    }
  }

  input.addEventListener('input', applyFilter);

  document.addEventListener('keydown', e => {
    if (e.key !== '/') return;
    const target = e.target;
    const isTyping = target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (isTyping) return;
    e.preventDefault();
    input.focus();
    input.select();
  });
})();
