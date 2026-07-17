// Tylko dla admin.html - pracownicy nie maja zadnego logowania, wiec ten
// skrypt jest ladowany wylacznie na stronie panelu administratora. Pokazuje
// przycisk wylogowania, jesli jest aktywna sesja admina (na profilu
// "windows" panel w ogole nie jest chroniony haslem, wiec /admin/whoami
// zawsze zwroci ok:false i przycisk zostaje ukryty).
(async function initAdminAuthStatus() {
  const logoutBtn = document.getElementById('logoutBtn');
  if (!logoutBtn) return;

  try {
    const response = await fetch('/admin/whoami', { cache: 'no-store' });
    const data = await response.json();
    if (data.ok) logoutBtn.hidden = false;
  } catch (_) {
    // Brak polaczenia - nic nie pokazujemy.
  }

  logoutBtn.addEventListener('click', async () => {
    logoutBtn.disabled = true;
    try {
      await fetch('/admin/logout', { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' } });
    } catch (_) {
      // Nawet jesli zadanie sieciowe zawiedzie, i tak przekierowujemy do
      // logowania - kolejne zadanie bez waznej sesji i tak zostanie odbite.
    }
    window.location.href = '/admin/login';
  });
})();
