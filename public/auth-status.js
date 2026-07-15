// Wspolny dla index.html i admin.html: pokazuje nazwe zalogowanego
// uzytkownika i przycisk wylogowania, gdy profil wymaga logowania. Na
// profilu "windows" /auth/whoami zawsze zwroci ok:false (auth nie jest
// wymagany), wiec przycisk po prostu zostaje ukryty - jeden skrypt dziala
// bezpiecznie na obu profilach.
(async function initAuthStatus() {
  const label = document.getElementById('authUserLabel');
  const logoutBtn = document.getElementById('logoutBtn');
  if (!label && !logoutBtn) return;

  try {
    const response = await fetch('/auth/whoami', { cache: 'no-store' });
    const data = await response.json();
    if (!data.ok || !data.user) return;
    if (label) {
      label.textContent = `Zalogowano: ${data.user.username}`;
      label.hidden = false;
    }
    if (logoutBtn) logoutBtn.hidden = false;
  } catch (_) {
    // Brak polaczenia albo profil bez logowania - nic nie pokazujemy.
  }

  logoutBtn?.addEventListener('click', async () => {
    logoutBtn.disabled = true;
    try {
      await fetch('/auth/logout', { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' } });
    } catch (_) {
      // Nawet jesli zadanie sieciowe zawiedzie, i tak przekierowujemy do
      // logowania - kolejne zadanie bez waznej sesji i tak zostanie odbite.
    }
    window.location.href = '/login';
  });
})();
