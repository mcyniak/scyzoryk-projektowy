const mainPanelHost = location.hostname === 'scyzoryk.localhost' ? 'scyzoryk.localhost' : '127.0.0.1';
const mainPanelUrl = `http://${mainPanelHost}:3000`;
document.querySelectorAll('[data-main-link]').forEach(link => { link.href = mainPanelUrl; link.removeAttribute('target'); });
