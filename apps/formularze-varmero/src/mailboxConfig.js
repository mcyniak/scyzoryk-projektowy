// Konfiguracja skrzynki pocztowej do odbioru kart Varmero.
//
// Do 1.3.10 dane skrzynki dalo sie podac WYLACZNIE przez zmienne srodowiskowe
// VARMERO_IMAP_* (patrz stary server.js#readImapConfig, oznaczony tam wprost
// jako placeholder). W praktyce oznaczalo to, ze narzedzia nie dalo sie
// uruchomic bez kogos, kto wejdzie na dany komputer i ustawi zmienne recznie -
// na innej maszynie niz wlasna byla to operacja "przyjedz do biura". Ten modul
// dodaje druga sciezke: zapis z interfejsu, tym samym wzorcem co klucz API w
// OCR audytow (patrz apps/ocr-audytow/src/geminiFieldEngine.js#getApiKey):
//
//   1. zmienne srodowiskowe VARMERO_IMAP_HOST/USER/PASSWORD (jesli sa - wygrywaja),
//   2. plik <dane Scyzoryka>/formularze-varmero/mailbox.json.
//
// Kolejnosc jest celowo taka sama jak w OCR: srodowisko przebija plik, wiec
// administrator, ktory ustawil zmienne na stale, nie zostanie po cichu
// nadpisany przez kogos klikajacego w interfejsie - dlatego getMailboxStatus()
// zwraca `source`, a ekran ustawien mowi wprost, kiedy decyduje zmienna
// srodowiskowa.
//
// Plik trzymamy w katalogu danych Scyzoryka (lib/appPaths.js), a NIE obok kodu
// apki - katalog danych celowo przezywa aktualizacje i przeinstalowanie (patrz
// README "Dane runtime, ustawienia i zapisane wzory").
//
// UWAGA: haslo jest w tym pliku zapisane jawnym tekstem. To ta sama wlasciwosc,
// co %LOCALAPPDATA%\Scyzoryk\gemini-api-key.json w OCR - IMAP wymaga hasla przy
// kazdym polaczeniu, wiec musi byc odwracalne, a Scyzoryk nie ma wlasnego
// magazynu sekretow. Dlatego interfejs i Pomoc konsekwentnie mowia o HASLE DO
// APLIKACJI (odwolywalnym osobno), nie o glownym hasle do poczty.
import fs from 'fs';
import path from 'path';
import { ImapFlow } from 'imapflow';
import appPaths from '../../../lib/appPaths.js';

const { getAppDataDir } = appPaths;

export const MAILBOX_CONFIG_FILENAME = 'mailbox.json';

export function getMailboxConfigPath() {
  return path.join(getAppDataDir('formularze-varmero'), MAILBOX_CONFIG_FILENAME);
}

function normalizePort(value, fallback = 993) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fallback;
  return port;
}

function readFromEnv() {
  const host = String(process.env.VARMERO_IMAP_HOST || '').trim();
  const user = String(process.env.VARMERO_IMAP_USER || '').trim();
  const pass = String(process.env.VARMERO_IMAP_PASSWORD || '');
  if (!host || !user || !pass) return null;
  return {
    host,
    port: normalizePort(process.env.VARMERO_IMAP_PORT),
    secure: String(process.env.VARMERO_IMAP_SECURE || 'true').toLowerCase() !== 'false',
    auth: { user, pass }
  };
}

function readFromFile() {
  let raw;
  try {
    raw = fs.readFileSync(getMailboxConfigPath(), 'utf8');
  } catch (err) {
    // Rozrozniamy "nigdy nie konfigurowano" od "plik jest, ale nie da sie go
    // odczytac" - ten sam powod co w ocr-audytow/src/aiProvider.js: cichy
    // powrot do "brak konfiguracji" przy uszkodzonym pliku wygladalby dla
    // uzytkownika jak skasowane ustawienia i skonczylby sie wpisywaniem hasla
    // od nowa zamiast naprawieniem prawdziwego problemu.
    if (err && err.code !== 'ENOENT') {
      console.error(`[formularze-varmero] Nie mozna odczytac pliku skrzynki: ${err.message}`);
    }
    return null;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`[formularze-varmero] Uszkodzony plik skrzynki (${getMailboxConfigPath()}): ${err.message}`);
    return null;
  }
  const host = String(data && data.host || '').trim();
  const user = String(data && data.user || '').trim();
  const pass = String(data && data.password || '');
  if (!host || !user || !pass) return null;
  return {
    host,
    port: normalizePort(data.port),
    secure: data.secure !== false,
    auth: { user, pass }
  };
}

// Pelna konfiguracja Z HASLEM - wylacznie do uzytku wewnetrznego (przekazanie
// do ImapFlow). Nigdy nie wolno zwracac tego z endpointu HTTP.
export function readMailboxConfig() {
  return readFromEnv() || readFromFile();
}

// Bezpieczne do pokazania na ekranie: bez hasla, za to z informacja SKAD
// pochodzi konfiguracja (patrz komentarz na gorze pliku).
export function getMailboxStatus() {
  const fromEnv = readFromEnv();
  const config = fromEnv || readFromFile();
  if (!config) return { configured: false, source: null, host: null, user: null, port: null };
  return {
    configured: true,
    source: fromEnv ? 'env' : 'file',
    host: config.host,
    user: config.auth.user,
    port: config.port
  };
}

export function validateMailboxInput(input) {
  const source = input || {};
  const cleanHost = String(source.host || '').trim();
  if (!cleanHost) throw new Error('Podaj adres serwera poczty przychodzącej (np. imap.gmail.com).');
  if (/\s/.test(cleanHost)) throw new Error('Adres serwera nie może zawierać spacji.');

  const cleanUser = String(source.user || '').trim();
  // Adres MUSI zawierac "@", bo kazde zgloszenie dostaje wlasny alias plusowy
  // wyprowadzony wlasnie z niego (jobs.js#deriveSubmissionEmail dzieli adres na
  // "@" i rzuca bez niego). Bez tego sprawdzenia blad wyszedlby dopiero w
  // trakcie paczki - czyli PO wyslaniu pierwszych, nieodwracalnych zgloszen do
  // kalkulatora Varmero.
  if (!cleanUser.includes('@')) throw new Error('Adres skrzynki musi być pełnym adresem e-mail (z "@").');

  // Google pokazuje haslo do aplikacji w czterech grupach po cztery znaki -
  // spacje sa tam tylko dla czytelnosci i NIE sa czescia hasla. Wklejone razem
  // z nimi daja "Invalid credentials", czego uzytkownik nie ma jak powiazac z
  // formatowaniem na ekranie Google, wiec czyscimy je tutaj.
  const cleanPassword = String(source.password || '').replace(/\s/g, '');
  if (!cleanPassword) throw new Error('Podaj hasło do skrzynki (dla Gmaila: hasło do aplikacji).');

  return {
    host: cleanHost,
    user: cleanUser,
    password: cleanPassword,
    port: normalizePort(source.port),
    secure: source.secure !== false
  };
}

function toImapConfig(input) {
  return {
    host: input.host,
    port: input.port,
    secure: input.secure,
    auth: { user: input.user, pass: input.password }
  };
}

// Zamienia surowy blad IMAP na komunikat, z ktorym pracownik biura ma co
// zrobic. Rozroznienie "zle haslo" od "nie ma polaczenia" jest tu kluczowe:
// pierwsze naprawia sie haslem do aplikacji, drugie nie ma z haslem nic
// wspolnego, a surowy tekst bledu wyglada w obu przypadkach tak samo obco.
export function describeImapError(err) {
  const raw = String((err && (err.responseText || err.message)) || err || '');
  const code = String((err && err.code) || '');
  if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|AUTHENTICATE/i.test(raw)) {
    return 'Skrzynka odrzuciła logowanie. Dla Gmaila potrzebne jest hasło do aplikacji (wymaga włączonej weryfikacji dwuetapowej), nie zwykłe hasło do poczty. W Microsoft 365 dostęp IMAP bywa wyłączony przez administratora.';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(code + raw)) {
    return 'Nie znaleziono takiego serwera poczty. Sprawdź adres (dla Gmaila: imap.gmail.com).';
  }
  if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|timeout/i.test(code + raw)) {
    return 'Nie udało się połączyć z serwerem poczty. Sprawdź połączenie z internetem i port (zwykle 993).';
  }
  return `Nie udało się połączyć ze skrzynką: ${raw || 'nieznany błąd'}`;
}

// Prawdziwe logowanie do skrzynki. `createClient` jest wstrzykiwalny dokladnie
// z tego samego powodu co w mailbox.js#waitForVarmeroCard - zeby testy
// jednostkowe nie potrzebowaly prawdziwej skrzynki.
export async function testMailboxConnection(input, options) {
  const createClient = options && options.createClient;
  const imapConfig = toImapConfig(input);
  const client = createClient
    ? createClient(imapConfig)
    : new ImapFlow({ ...imapConfig, logger: false });
  try {
    await client.connect();
    const folders = await client.list();
    return { ok: true, folders: (folders || []).map(f => f.path) };
  } finally {
    await client.logout().catch(() => {});
  }
}

export function saveMailboxConfig(input) {
  const clean = validateMailboxInput(input);
  const target = getMailboxConfigPath();
  // Zapis atomowy (tmp + rename): przerwanie w polowie zostawiloby plik z
  // polowa JSON-a, a wtedy readFromFile() uznaje go za uszkodzony i narzedzie
  // wyglada na niekonfigurowalne mimo poprawnie wpisanych danych.
  const tmp = `${target}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({
    host: clean.host,
    user: clean.user,
    password: clean.password,
    port: clean.port,
    secure: clean.secure,
    savedAt: new Date().toISOString()
  }, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, target);
  return getMailboxStatus();
}

export function clearMailboxConfig() {
  try {
    fs.unlinkSync(getMailboxConfigPath());
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  return getMailboxStatus();
}
