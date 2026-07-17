const cards = new Map([...document.querySelectorAll('.tool-card')].map(card => [card.dataset.app, card]));
function setText(selector, value) {
  const el = document.querySelector(selector);
  if (el) el.textContent = value;
}
async function refreshStatus() {
  try {
    const response = await fetch('/api/apps', { cache: 'no-store' });
    const data = await response.json();
    const apps = data.apps || [];
    // /api/apps jest juz filtrowane po stronie serwera wg aktywnego profilu
    // (SCYZORYK_PROFILE) - kafelek aplikacji spoza tej listy nie powinien
    // w ogole byc widoczny na pilocie, zamiast wisiec ze stara/martwa
    // tresc statycznego HTML-a na zawsze.
    const enabledSlugs = new Set(apps.map(a => a.slug));
    for (const [slug, card] of cards.entries()) {
      card.hidden = !enabledSlugs.has(slug);
    }
    for (const app of apps) {
      const card = cards.get(app.slug);
      if (!card) continue;
      const badge = card.querySelector('.badge');
      const link = card.querySelector('a.button-link');
      if (link && app.url) link.href = app.url;
      card.classList.toggle('disabled', !app.running);
      card.classList.toggle('warn', Boolean(app.processAlive && !app.running));
      if (badge) {
        // Prosty, zrozumialy status zamiast technicznego zargonu (restarty,
        // czasy odpowiedzi itp.) - to jest panel dla zwyklych pracownikow,
        // szczegoly techniczne sa tylko w panelu administratora.
        badge.textContent = app.running ? 'gotowe' : (app.processAlive ? 'uruchamianie...' : 'chwila przerwy, wraca za moment');
        badge.classList.toggle('online', Boolean(app.running));
        badge.classList.toggle('offline', !app.running);
      }
    }
  } catch (error) {
    for (const card of cards.values()) {
      const badge = card.querySelector('.badge');
      if (!badge) continue;
      badge.textContent = 'chwilowo niedostępne';
      badge.classList.add('offline');
    }
  }
}
document.querySelector('#refreshBtn')?.addEventListener('click', refreshStatus);
refreshStatus();
setInterval(refreshStatus, 10000);
