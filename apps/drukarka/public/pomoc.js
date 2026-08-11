const mainPanelUrl = 'http://scyzoryk.localhost:3000';
document.querySelectorAll('[data-main-link]').forEach(link => { link.href = mainPanelUrl; link.removeAttribute('target'); });
document.querySelectorAll('[data-main-asset]').forEach(el => { el.src = mainPanelUrl + el.dataset.mainAsset; });
