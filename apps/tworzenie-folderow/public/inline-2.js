const mainPanelUrl = 'http://scyzoryk.localhost:3000';
document.querySelectorAll('[data-main-link]').forEach(link => { link.href = mainPanelUrl; link.removeAttribute('target'); });
