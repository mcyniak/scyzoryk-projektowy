(async function setMainPanelLink() {
  let mainPort = 3000;
  try {
    const res = await fetch('api/panel-info', { cache: 'no-store' });
    const data = await res.json();
    if (data.mainPort) mainPort = data.mainPort;
  } catch (_) {
    // Brak polaczenia z wlasnym serwerem - zostaw domyslny port 3000.
  }
  const mainPanelUrl = window.location.protocol + '//' + window.location.hostname + ':' + mainPort;
  document.querySelectorAll('[data-main-link]').forEach(link => { link.href = mainPanelUrl; link.removeAttribute('target'); });
})();
