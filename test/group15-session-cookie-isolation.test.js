// Audyt v1.0.8, Priorytet 3: drukarka-projekty i nazywarka-skanow uzywaly
// TEJ SAMEJ nazwy ciasteczka sesji ("scyzoryk_sid"). Ciasteczka na 127.0.0.1
// NIE sa rozdzielane wedlug portu (tylko Domain+Path) - dwie apki na roznych
// portach tego samego hosta dzielily wiec jeden slot ciasteczka i nadpisywaly
// sobie nawzajem sid, gubiac stan (kolejke druku / otwarty folder skanow).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const drukarkaProjektySession = require('../apps/drukarka-projekty/lib/sessionStore');
const nazywarkaSkanowSession = require('../apps/nazywarka-skanow/lib/sessionStore');
const { app: drukarkaProjektyApp } = require('../apps/drukarka-projekty/server');
const { app: nazywarkaSkanowApp } = require('../apps/nazywarka-skanow/server');

function fakeReq(cookieHeader) {
  return { headers: { cookie: cookieHeader || '' } };
}
function fakeRes() {
  const res = { headers: {} };
  res.setHeader = (name, value) => { res.headers[name] = value; };
  return res;
}
function extractCookiePair(res) {
  const raw = res.headers['Set-Cookie'];
  const match = /^([^=]+)=([^;]+)/.exec(raw || '');
  return match ? { name: match[1], value: match[2] } : null;
}

test('drukarka-projekty i nazywarka-skanow uzywaja ROZNYCH nazw ciasteczek sesji', () => {
  assert.notEqual(drukarkaProjektySession.SESSION_COOKIE, nazywarkaSkanowSession.SESSION_COOKIE);
  assert.equal(drukarkaProjektySession.SESSION_COOKIE, 'scyzoryk_drukarka_projekty_sid');
  assert.equal(nazywarkaSkanowSession.SESSION_COOKIE, 'scyzoryk_nazywarka_skanow_sid');
});

test('sesja jednej apki przetrwa gdy w tym samym magazynie ciasteczek (przegladarki) jest TAKZE ciasteczko drugiej apki', () => {
  const dpMiddleware = drukarkaProjektySession.sessionMiddleware(() => ({ queue: [], marker: null }));
  const nsMiddleware = nazywarkaSkanowSession.sessionMiddleware(() => ({ folderPath: null, marker: null }));

  // Pierwsze zadanie do kazdej apki (przegladarka nie ma jeszcze zadnych
  // ciasteczek Scyzoryka) - kazda apka zaklada wlasna sesje i wystawia WLASNE
  // ciasteczko.
  const dpReq1 = fakeReq('');
  const dpRes1 = fakeRes();
  dpMiddleware(dpReq1, dpRes1, () => {});
  dpReq1.session.marker = 'drukarka-projekty-dane';

  const nsReq1 = fakeReq('');
  const nsRes1 = fakeRes();
  nsMiddleware(nsReq1, nsRes1, () => {});
  nsReq1.session.marker = 'nazywarka-skanow-dane';

  const dpCookie = extractCookiePair(dpRes1);
  const nsCookie = extractCookiePair(nsRes1);
  assert.ok(dpCookie, 'drukarka-projekty musi wystawic ciasteczko');
  assert.ok(nsCookie, 'nazywarka-skanow musi wystawic ciasteczko');
  assert.notEqual(dpCookie.name, nsCookie.name);

  // Symulacja WSPOLNEGO magazynu ciasteczek przegladarki - po odwiedzeniu
  // obu aplikacji przegladarka wysyla OBA ciasteczka w kazdym kolejnym
  // zadaniu, niezaleznie do ktorej apki.
  const sharedCookieHeader = `${dpCookie.name}=${dpCookie.value}; ${nsCookie.name}=${nsCookie.value}`;

  const dpReq2 = fakeReq(sharedCookieHeader);
  const dpRes2 = fakeRes();
  dpMiddleware(dpReq2, dpRes2, () => {});
  assert.equal(dpReq2.sid, dpReq1.sid, 'drukarka-projekty musi odnalezc SWOJA sesje po sid');
  assert.equal(dpReq2.session.marker, 'drukarka-projekty-dane', 'stan sesji drukarki-projekty nie moze zniknac');

  const nsReq2 = fakeReq(sharedCookieHeader);
  const nsRes2 = fakeRes();
  nsMiddleware(nsReq2, nsRes2, () => {});
  assert.equal(nsReq2.sid, nsReq1.sid, 'nazywarka-skanow musi odnalezc SWOJA sesje po sid');
  assert.equal(nsReq2.session.marker, 'nazywarka-skanow-dane', 'stan sesji nazywarki-skanow nie moze zniknac');
});

test('realne endpointy /api/health obu apek wystawiaja Set-Cookie o roznych nazwach (dym-test wpiecia sessionMiddleware)', async (t) => {
  const dpServer = drukarkaProjektyApp.listen(0, '127.0.0.1');
  const nsServer = nazywarkaSkanowApp.listen(0, '127.0.0.1');
  t.after(() => { dpServer.close(); nsServer.close(); });
  // WAZNE: obie obietnice trzeba utworzyc (i tym samym podpiac listenery
  // 'listening') PRZED jakimkolwiek await - inaczej pierwszy await odda
  // sterowanie petli zdarzen, drugi serwer zdazy sie juz wystartowac i
  // wyemitowac 'listening' ZANIM .once() zostanie podpiety, i drugi await
  // zawiesi sie na zawsze (przegapione zdarzenie, nie realny blad aplikacji -
  // zlapane podczas pisania tego testu).
  const dpListening = new Promise(resolve => dpServer.once('listening', () => resolve(dpServer.address().port)));
  const nsListening = new Promise(resolve => nsServer.once('listening', () => resolve(nsServer.address().port)));
  const [dpPort, nsPort] = await Promise.all([dpListening, nsListening]);

  const dpRes = await fetch(`http://127.0.0.1:${dpPort}/api/health`);
  const nsRes = await fetch(`http://127.0.0.1:${nsPort}/api/health`);
  const dpCookieName = (dpRes.headers.get('set-cookie') || '').split('=')[0];
  const nsCookieName = (nsRes.headers.get('set-cookie') || '').split('=')[0];
  assert.equal(dpCookieName, 'scyzoryk_drukarka_projekty_sid');
  assert.equal(nsCookieName, 'scyzoryk_nazywarka_skanow_sid');
});

test('zadne dwie apki w repo nie uzywaja tej samej nazwy ciasteczka sesji (ochrona na przyszlosc)', () => {
  const appsDir = path.join(__dirname, '..', 'apps');
  const appNames = fs.readdirSync(appsDir).filter(name => fs.existsSync(path.join(appsDir, name, 'lib', 'sessionStore.js')));
  const seen = new Map();
  const collisions = [];
  for (const name of appNames) {
    const source = fs.readFileSync(path.join(appsDir, name, 'lib', 'sessionStore.js'), 'utf8');
    const match = source.match(/const SESSION_COOKIE = "([^"]+)"/);
    if (!match) { collisions.push(`${name}: brak SESSION_COOKIE do sprawdzenia`); continue; }
    const cookieName = match[1];
    if (seen.has(cookieName)) collisions.push(`${name} i ${seen.get(cookieName)} uzywaja tej samej nazwy ciasteczka "${cookieName}"`);
    seen.set(cookieName, name);
  }
  assert.deepEqual(collisions, []);
});
