// Anonimowa sesja robocza - KAZDA przegladarka dostaje ja automatycznie,
// bez podawania jakichkolwiek danych logowania (pracownicy nie maja kont).
// Sluzy wylacznie do odizolowania danych roboczych jednej przegladarki od
// drugiej (uploady, zadania, wyniki, kolejki widoczne w interfejsie) - NIE
// jest to tozsamosc uzytkownika i nie daje dostepu do niczego, do czego
// zwykly anonimowy gosc nie powinien miec dostepu.
const { createSessionStore } = require('./genericSessionStore');
const cookies = require('./cookies');

const store = createSessionStore('sessions', cookies.SESSION_MAX_IDLE_MS);

function createAnonymousSession() {
  return store.create();
}

function getAnonymousSession(sid) {
  return store.get(sid);
}

function touchAnonymousSession(sid) {
  store.touch(sid);
}

function destroyAnonymousSession(sid) {
  store.destroy(sid);
}

function startCleanupTimer() {
  return store.startCleanupTimer();
}

module.exports = {
  createAnonymousSession,
  getAnonymousSession,
  touchAnonymousSession,
  destroyAnonymousSession,
  startCleanupTimer,
};
