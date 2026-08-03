// Parsowanie i porownywanie wersji SemVer (tylko MAJOR.MINOR.PATCH, bez
// pre-release/build metadata - to jest jedyny format uzywany przez tagi Git i
// package.json w tym repo). Porownanie jest NUMERYCZNE per-segment, nie
// tekstowe - "1.10.0" musi wypadac jako nowsze niz "1.9.0", mimo ze
// alfabetycznie "1.10.0" < "1.9.0".

// Akceptuje opcjonalny prefiks "v"/"V" (tagi Git to "v1.2.0"). Zwraca null
// dla dowolnego innego formatu (pre-release "-beta", build "+meta", brakujace
// segmenty, litery, spacje w liczbach itd.) - wywolujacy decyduje, czy to
// blad krytyczny czy tylko "nie da sie porownac".
function parseVersion(raw) {
  const text = String(raw == null ? '' : raw).trim();
  const match = text.match(/^[vV]?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: text
  };
}

function isValidVersion(raw) {
  return parseVersion(raw) !== null;
}

// Zwraca <0 gdy a<b, 0 gdy rowne, >0 gdy a>b. Rzuca blad przy niepoprawnym
// formacie ktoregokolwiek argumentu - wywolujacy w kodzie produkcyjnym musi
// sam zdecydowac czy to jest sytuacja do zlapania (np. uszkodzone
// build-info.json) czy do propagacji.
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va) throw new Error(`Nieprawidlowy format wersji SemVer: "${a}".`);
  if (!vb) throw new Error(`Nieprawidlowy format wersji SemVer: "${b}".`);
  if (va.major !== vb.major) return va.major - vb.major;
  if (va.minor !== vb.minor) return va.minor - vb.minor;
  return va.patch - vb.patch;
}

// true tylko gdy candidate jest OSTRO nowszy niz current - wersje rowne albo
// candidate starszy (downgrade) nigdy nie sa "aktualizacja".
function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

// Normalizuje do "MAJOR.MINOR.PATCH" bez prefiksu "v" - uzywane przy
// budowaniu nazw plikow instalatora, ktore NIE maja prefiksu "v"
// (ScyzorykProjektowy-Setup-1.2.0.exe), w odroznieniu od tagow Git (v1.2.0).
function toPlainVersion(raw) {
  const parsed = parseVersion(raw);
  if (!parsed) throw new Error(`Nieprawidlowy format wersji SemVer: "${raw}".`);
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

module.exports = {
  parseVersion,
  isValidVersion,
  compareVersions,
  isNewerVersion,
  toPlainVersion
};
