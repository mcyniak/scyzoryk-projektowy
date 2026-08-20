// Wspolna czesc wzorca bezpieczenstwa, ktory kazdy server.js (root + apps/*)
// powielal osobno (patrz CLAUDE.md "Security posture") - audyt zewnetrzny
// (2026-08-20) zwrocil uwage, ze 13 niezaleznych kopii tej samej logiki to
// ryzyko: latwo o nia zapomniec przy dodawaniu nowej apki albo zmienic w
// jednym miejscu, a nie we wszystkich.
//
// CELOWO nie ujednolica wszystkiego: Content-Security-Policy i tresc
// odpowiedzi 403 roznia sie miedzy apkami (np. `img-src` z `worker-src` w
// pieczatki-pdf dla podgladu PDF, `frame-src blob:` w kilku innych) - to sa
// prawdziwe, apkowe wymagania, nie przypadkowy dryf. Ujednolicone jest
// wylacznie to, co bylo bajt-w-bajt identyczne we wszystkich 13 plikach:
// 5 stalych naglowkow bezpieczenstwa i sama logika bramki mutujacych zadan
// (dozwolone metody + wymagany naglowek) - wywolujacy nadal decyduje, jakim
// cialem JSON odpowiedziec na odrzucenie.
const MUTATION_GUARD_HEADER = 'X-Scyzoryk-Request';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Bajt-w-bajt identyczne we wszystkich 13 server.js przed refaktorem - patrz
// scripts/security-smoke-test.js, ktory zaklada dokladnie ten zestaw.
const BASE_SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

function securityHeaders(contentSecurityPolicy) {
  return { ...BASE_SECURITY_HEADERS, 'Content-Security-Policy': contentSecurityPolicy };
}

// Ustawia naglowki bezpieczenstwa na kazdej odpowiedzi i wylacza X-Powered-By.
// `contentSecurityPolicy` to gotowy string CSP tej konkretnej apki.
function applySecurityHeaders(app, contentSecurityPolicy) {
  const headers = securityHeaders(contentSecurityPolicy);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    next();
  });
  return headers;
}

function isMutationAllowed(req) {
  return SAFE_METHODS.has(req.method) || req.get(MUTATION_GUARD_HEADER) === '1';
}

// Blokuje kazde zadanie mutujace (nie-GET/HEAD/OPTIONS) bez naglowka
// X-Scyzoryk-Request - jedyny sposob, w jaki front-end tej samej apki (i
// tylko tej samej apki, bo naglowek nie jest ustawiany automatycznie przez
// przegladarke przy zadaniach z innych origin) moze wywolac zmiane stanu.
// `onRejected(req, res)` odpowiada wlasnym cialem JSON - rozne apki maja
// dzis rozny ksztalt tej odpowiedzi (`{ok,message}` / `{ok,error}` /
// `{error}`), wiec zostaje to po stronie wywolujacego zamiast wymuszac
// jeden ksztalt i ryzykowac zlamanie front-endu, ktory go czyta.
function applyMutationGuard(app, onRejected) {
  app.use((req, res, next) => {
    if (isMutationAllowed(req)) return next();
    onRejected(req, res);
  });
}

module.exports = {
  MUTATION_GUARD_HEADER,
  BASE_SECURITY_HEADERS,
  securityHeaders,
  applySecurityHeaders,
  isMutationAllowed,
  applyMutationGuard,
};
