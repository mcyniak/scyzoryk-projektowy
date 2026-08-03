// Komunikacja z publicznym GitHub Releases API - wylacznie wbudowanym
// modulem `https`, bez zewnetrznej biblioteki HTTP (to jedno zapytanie JSON,
// wyciaganie zaleznosci tylko po to nie ma sensu). Zero tokenow/sekretow -
// dziala tak jak kazde anonimowe zapytanie do publicznego repo.
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { toPlainVersion } = require('./updateVersion');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_JSON_BYTES = 2 * 1024 * 1024; // 2 MB - odpowiedz /releases/latest nigdy nie jest wieksza
const USER_AGENT = 'ScyzorykProjektowy-Updater';

// W produkcji jedynym dozwolonym protokolem jest HTTPS. Zwykly HTTP jest
// dopuszczony WYLACZNIE do loopbacku (127.0.0.1/localhost/::1) - to moze byc
// jedynie lokalny mock testowy podstawiany przez SCYZORYK_UPDATE_API_BASE_URL
// (patrz README/sekcja testowa), nigdy prawdziwy host GitHuba. Ktos zdolny
// przekierowac nasze wlasne polaczenie do loopbacku na wlasnym komputerze ma
// juz pelna kontrole nad maszyna, wiec ten wyjatek nie otwiera nowego ataku.
function isAllowedProtocol(parsedUrl) {
  if (parsedUrl.protocol === 'https:') return true;
  return parsedUrl.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsedUrl.hostname);
}

// Pojedyncze zapytanie GET po JSON z limitem rozmiaru, timeoutem i
// obsluga przekierowan (GitHub czasem przekierowuje /releases/latest do
// konkretnego /releases/tags/vX.Y.Z). Tylko HTTPS - nigdy nie wykonuje
// zwyklego HTTP, nawet jesli serwer by o to poprosil przekierowaniem.
function httpsGetJson(urlString, options = {}) {
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const maxRedirects = Number.isInteger(options.maxRedirects) ? options.maxRedirects : DEFAULT_MAX_REDIRECTS;
  const maxBytes = Number(options.maxBytes || DEFAULT_MAX_JSON_BYTES);
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json', ...(options.headers || {}) };

  function attempt(currentUrl, redirectsLeft) {
    return new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch (_) {
        return reject(new Error(`Nieprawidlowy adres URL: ${currentUrl}`));
      }
      if (!isAllowedProtocol(parsed)) {
        return reject(new Error(`Zablokowano polaczenie inne niz HTTPS: ${currentUrl}`));
      }
      // Modul `https` odrzuca URL-e http: na poziomie samej biblioteki, wiec
      // dla dopuszczonego loopback-wyjatku (patrz isAllowedProtocol) trzeba
      // wprost uzyc modulu `http` - transport wybieramy PO wlasnej walidacji
      // protokolu powyzej, nigdy odwrotnie.
      const client = parsed.protocol === 'https:' ? https : http;

      const req = client.get(parsed, { headers, timeout: timeoutMs }, res => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('Przekroczono limit przekierowan HTTPS.'));
          let nextUrl;
          try {
            nextUrl = new URL(res.headers.location, parsed).toString();
          } catch (_) {
            return reject(new Error('Nieprawidlowy adres przekierowania.'));
          }
          return resolve(attempt(nextUrl, redirectsLeft - 1));
        }

        const chunks = [];
        let total = 0;
        res.on('data', chunk => {
          total += chunk.length;
          if (total > maxBytes) {
            req.destroy(new Error('Przekroczono maksymalny rozmiar odpowiedzi.'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (status < 200 || status >= 300) {
            return reject(new Error(`GitHub odpowiedzial kodem ${status}.`));
          }
          let data;
          try {
            data = JSON.parse(body);
          } catch (_) {
            return reject(new Error('Odpowiedz GitHub nie jest poprawnym JSON-em.'));
          }
          resolve(data);
        });
      });

      req.on('timeout', () => req.destroy(new Error('Przekroczono limit czasu polaczenia z GitHub.')));
      req.on('error', reject);
    });
  }

  return attempt(urlString, maxRedirects);
}

function assetFileName(installerVersion) {
  return `ScyzorykProjektowy-Setup-${toPlainVersion(installerVersion)}.exe`;
}

// Zwraca DOKLADNIE jeden pasujacy asset po nazwie (rowniej dla instalatora
// jak i sumy .sha256) - nigdy "pierwszy plik .exe z wydania". Rzuca blad
// gdy brakuje albo gdy jest wiecej niz jedno dopasowanie (niejednoznaczne
// wydanie, np. dwa assety o identycznej nazwie po literowce w procesie
// publikacji).
function findExactAsset(assets, exactName) {
  const matches = (Array.isArray(assets) ? assets : []).filter(a => a && a.name === exactName);
  if (matches.length === 0) throw new Error(`Nie znaleziono pliku "${exactName}" w wydaniu.`);
  if (matches.length > 1) throw new Error(`Znaleziono ${matches.length} plikow o nazwie "${exactName}" w wydaniu - niejednoznaczne wydanie.`);
  return matches[0];
}

// Zwraca { version, name, notes, publishedAt, installerAsset, shaAsset } dla
// najnowszego STABILNEGO wydania, albo null gdy nie ma zadnego stabilnego
// wydania (tylko drafty/prerelease, albo repo bez wydan) - to NIE jest blad,
// tylko brak aktualizacji do zaproponowania.
async function fetchLatestRelease(repo, options = {}) {
  const apiBase = options.apiBaseUrl || 'https://api.github.com';
  const url = `${apiBase.replace(/\/+$/, '')}/repos/${repo}/releases/latest`;
  let release;
  try {
    release = await httpsGetJson(url, options);
  } catch (err) {
    if (/kodem 404/.test(err.message)) return null; // repo bez wydan, albo prywatne/niedostepne
    throw err;
  }

  // /releases/latest z definicji GitHub API juz wyklucza drafty/prerelease,
  // ale sprawdzamy to jeszcze raz wprost - odpornosc na testowe/mockowane
  // odpowiedzi oraz na przyszla zmiane zachowania API.
  if (!release || typeof release !== 'object') return null;
  if (release.draft === true || release.prerelease === true) return null;

  const tagName = String(release.tag_name || '').trim();
  if (!tagName) throw new Error('Wydanie GitHub nie ma tagu.');

  const installerName = assetFileName(tagName);
  const shaName = `${installerName}.sha256`;
  const installerAsset = findExactAsset(release.assets, installerName);
  const shaAsset = findExactAsset(release.assets, shaName);

  return {
    version: toPlainVersion(tagName),
    tagName,
    name: String(release.name || tagName),
    notes: String(release.body || ''),
    publishedAt: String(release.published_at || release.created_at || ''),
    installerAsset: {
      name: installerAsset.name,
      url: String(installerAsset.browser_download_url || ''),
      sizeBytes: Number(installerAsset.size || 0)
    },
    shaAsset: {
      name: shaAsset.name,
      url: String(shaAsset.browser_download_url || ''),
      sizeBytes: Number(shaAsset.size || 0)
    }
  };
}

module.exports = {
  httpsGetJson,
  assetFileName,
  findExactAsset,
  fetchLatestRelease,
  isAllowedProtocol,
  USER_AGENT
};
