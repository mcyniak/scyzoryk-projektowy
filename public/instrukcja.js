(() => {
  const files = [
    '/instrukcja-sections/01-start.html',
    '/instrukcja-sections/02-documents-stamps.html',
    '/instrukcja-sections/03-printing-projects.html',
    '/instrukcja-sections/04-ecodan-wnioski.html',
    '/instrukcja-sections/05-karty-ocr-pomoc.html'
  ];
  const target = document.getElementById('guideContent');
  const panelHost = location.hostname === 'scyzoryk.localhost' ? 'scyzoryk.localhost' : '127.0.0.1';
  const mainPanelUrl = `http://${panelHost}:3000`;
  async function loadGuide() {
    const responses = await Promise.all(files.map(file => fetch(file, { cache: 'no-store' })));
    const failed = responses.find(response => !response.ok);
    if (failed) throw new Error(`HTTP ${failed.status}`);
    const parts = await Promise.all(responses.map(response => response.text()));
    target.innerHTML = parts.join('\n');
    document.querySelectorAll('[data-main-panel-link], a.plain[href="/"]').forEach(el => { el.href = mainPanelUrl; });
    document.querySelectorAll('[data-app-link]').forEach(el => { el.href = `http://${panelHost}:${el.dataset.appLink}/pomoc.html`; });
    if (location.hash) requestAnimationFrame(() => document.querySelector(location.hash)?.scrollIntoView());
  }
  loadGuide().catch(error => {
    target.innerHTML = `<section class="tool"><h1>Nie udało się otworzyć instrukcji</h1><p>Uruchom ponownie Scyzoryk i spróbuj jeszcze raz.</p><p class="mono">${String(error.message || error)}</p></section>`;
  });
})();
