const mainPanelUrl = window.location.protocol + '//' + window.location.hostname + ':3000';
    document.querySelectorAll('[data-main-link]').forEach(link => { link.href = mainPanelUrl; link.removeAttribute('target'); });
