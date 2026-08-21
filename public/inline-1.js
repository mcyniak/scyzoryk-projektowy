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
// Audyt zuzycia RAM 2026-08-21: rozwijalna lista pod paskiem "Zuzycie
// zasobow" - panel (proces glowny) + kazde URUCHOMIONE narzedzie, zeby
// bylo widac, co realnie zajmuje RAM, zamiast jednej zbiorczej liczby.
function renderMemoryBreakdown(data, apps) {
  const list = document.querySelector('#memoryBreakdownList');
  if (!list) return;
  const rows = [`<div class="resource-usage-row"><span>Panel (proces główny)</span><strong>${fmtMb(data.panelMemoryBytes ?? data.memory?.rss ?? 0)}</strong></div>`];
  for (const app of apps) {
    if (!app.processAlive) continue;
    const wartosc = app.memoryBytes == null ? '…' : fmtMb(app.memoryBytes);
    rows.push(`<div class="resource-usage-row"><span>${escapeHtmlBasic(app.name)}</span><strong>${wartosc}</strong></div>`);
  }
  list.innerHTML = rows.join('');
}

function escapeHtmlBasic(value) {
  return String(value).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

async function refreshStatus() {
  try {
    const response = await fetch('/api/apps', { cache: 'no-store' });
    const data = await response.json();
    const apps = data.apps || [];
    const running = apps.filter(a => a.running).length;
    if (data.version) setText('#panelVersionLabel', `v${data.version}`);
    setText('#metricServices', `${running}/${apps.length}`);
    // Audyt zuzycia RAM 2026-08-21: pokazujemy totalMemoryBytes (panel +
    // KAZDE narzedzie WRAZ z jego potomkami, np. Chromium) zamiast dawnego
    // data.memory.rss, ktore bylo tylko procesem panelu - myslace, bo
    // panel moze pokazywac np. 70 MB, podczas gdy caly Scyzoryk realnie
    // zuzywa kilkaset MB. Fallback na samo rss, gdyby starszy panel/testowy
    // mock nie mial jeszcze totalMemoryBytes w odpowiedzi.
    setText('#metricMemory', fmtMb(data.totalMemoryBytes ?? data.memory?.rss ?? 0));
    setText('#metricStorage', fmtMb(data.storage?.bytes || 0));
    setText('#metricMode', data.host === '127.0.0.1' ? 'Lokalny' : data.host);
    setText('#lastRefresh', `Ostatnie sprawdzenie: ${new Date().toLocaleTimeString('pl-PL')}`);
    setText('#statOnline', String(running));
    setText('#statTotal', String(apps.length));
    renderMemoryBreakdown(data, apps);
    for (const app of apps) {
      const card = cards.get(app.slug);
      if (!card) continue;
      const badge = card.querySelector('.badge');
      const link = card.querySelector('a.button-link');
      const meta = card.querySelector('.card-meta');
      if (link && app.url) link.href = app.url;
      // Audyt zuzycia RAM 2026-08-21 (lazy-start): "nieuruchomiona" jest
      // teraz DOMYSLNYM stanem KAZDEGO narzedzia, dopoki ktos go nie
      // otworzy - to nie jest usterka, wiec taka karta NIE powinna wygladac
      // przygaszona/zepsuta jak reszta panelu przy pierwszym zaladowaniu.
      // Przygaszamy tylko realne problemy: proces w trakcie startu,
      // zablokowany restartami, albo taki, ktory kiedys sam wypadl.
      const dormant = !app.running && !app.processAlive && !app.child?.circuitOpen && !app.child?.lastExit;
      card.classList.toggle('disabled', !app.running && !dormant);
      card.classList.toggle('warn', Boolean((app.processAlive && !app.running) || app.child?.circuitOpen));
      if (badge) {
        badge.textContent = app.running
          ? 'gotowe'
          : app.child?.circuitOpen
            ? 'awaria — uruchom ponownie Scyzoryka'
            : app.processAlive
              ? 'uruchamianie…'
              : dormant
                ? 'kliknij „Otwórz”, aby uruchomić'
                : 'zatrzymane — kliknij „Otwórz”';
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
// Lazy-start (audyt zuzycia RAM 2026-08-21): "Otworz" juz nie jest zwyklym
// linkiem do procesu, ktory i tak juz dziala - najpierw prosi panel o start
// (jesli trzeba), krotko odpytuje /api/apps az narzedzie odpowie na
// /api/health, i dopiero wtedy nawiguje. Bez tego pierwsze klikniecie w
// nigdy-nieotwarte narzedzie ladowaloby pusta karte przegladarki ("nie mozna
// polaczyc"), bo proces jeszcze by nie zdazyl wstac.
async function openTool(event) {
  const link = event.currentTarget;
  const card = link.closest('.tool-card');
  const slug = card?.dataset.app;
  const url = link.href;
  if (!slug || !url) return;
  event.preventDefault();

  const badge = card.querySelector('.badge');
  const originalBadgeText = badge?.textContent;
  try {
    if (badge) badge.textContent = 'uruchamiam…';
    await fetch(`/api/apps/${encodeURIComponent(slug)}/start`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' } });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch('/api/apps', { cache: 'no-store' });
        const data = await res.json();
        if (data.apps?.find(a => a.slug === slug)?.running) { window.location.href = url; return; }
      } catch (_) { /* przejsciowy blad sieci - kolejna proba za chwile */ }
      await new Promise(resolve => setTimeout(resolve, 700));
    }
    if (badge) badge.textContent = 'nie udało się uruchomić — spróbuj ponownie';
  } catch (error) {
    if (badge) badge.textContent = originalBadgeText || 'błąd uruchamiania';
  }
}
for (const card of cards.values()) {
  card.querySelector('a.button-link')?.addEventListener('click', openTool);
}

document.querySelector('#refreshBtn')?.addEventListener('click', refreshStatus);
refreshStatus();
// Audyt zuzycia RAM/CPU 2026-08-21: 10s bylo czesciej niz potrzeba dla
// samego "czy apka zyje" (status apek nie zmienia sie co kilka sekund w
// normalnej pracy), a odpytywanie calkiem staje, gdy karta panelu jest
// niewidoczna (uzytkownik pracuje w innej apce/karcie) - zero sensu w
// odpytywaniu w tle.
let statusPollTimer = setInterval(refreshStatus, 20000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearInterval(statusPollTimer);
  } else {
    refreshStatus();
    statusPollTimer = setInterval(refreshStatus, 20000);
  }
});

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
