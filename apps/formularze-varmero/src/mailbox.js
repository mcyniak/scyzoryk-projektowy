// Odbior karty z maila - GENUINELE NOWA ZDOLNOSC w tym repo (potwierdzone
// researchem tej sesji: zero kodu IMAP/poczty gdziekolwiek indziej). Uzywa
// `imapflow` (polaczenie) + `mailparser` (parsowanie MIME/zalacznikow).
//
// Zweryfikowane bezposrednio na prawdziwym zgloszeniu w tej sesji: mail od
// Varmero ma 4 "zalaczniki", z ktorych tylko JEDEN jest wlasciwa karta:
//   - Varmero-podsumowanie-<numer>.pdf   <- TA karta, jedyna potrzebna
//   - tabela-danych-technicznych-varmero-vpm-*.pdf  <- ogolna specyfikacja
//     modelu, ta sama dla kazdego klienta z tym samym urzadzeniem,
//     CELOWO POMIJANA
//   - embed0 / embed1  <- to w ogole NIE sa prawdziwe zalaczniki, tylko
//     obrazki osadzone w tresci HTML maila (logo, pasek kolorow) -
//     CELOWO POMIJANE
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const VARMERO_SENDER = 'noreply@varmero.pl';
const CARD_FILENAME_PATTERN = /^Varmero-podsumowanie-.*\.pdf$/i;

export class NoNewEmailError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoNewEmailError';
  }
}

// Audyt 2026-08-21 - patrz komentarz przy waitForVarmeroCard.
export class CancelledWaitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CancelledWaitError';
  }
}

// Wybiera wlasciwy zalacznik (karte) z juz sparsowanej listy zalacznikow
// maila - czysta funkcja, testowalna bez prawdziwego polaczenia IMAP.
export function pickCardAttachment(attachments) {
  return (attachments || []).find(a => CARD_FILENAME_PATTERN.test(String(a?.filename || '')));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Czeka na mail od Varmero zaadresowany do `recipientEmail` i zwraca
// { buffer, filename } jego wlasciwego zalacznika (karty).
//
// WAZNA POPRAWKA (2026-08-10, realny blad zlapany w tej sesji): pierwotna
// wersja dopasowywala "najnowszy mail od Varmero nowszy niz sinceDate" -
// zlamalo sie to na prawdziwym batchu z 2 wierszami, bo (a) IMAP-owe
// kryterium SEARCH SINCE porownuje WYLACZNIE DATE, nie dokladny czas (RFC
// 3501) - "od dzisiaj" zlapalo KAZDY dzisiejszy mail od Varmero, nie tylko
// nowszy niz submittedAt tego konkretnego wiersza; (b) wczesniejszy test
// tego samego dnia zostal recznie oznaczony "to nie spam" i przeniesiony do
// INBOX (ktory jest sprawdzany PIERWSZY) - w efekcie kolejne zgloszenie
// dostalo z powrotem karte z zupelnie INNEGO, starszego testu. Poprawne
// rozwiazanie: kazdy wiersz dostaje WLASNY, unikalny adres plusowy (patrz
// jobs.js#processRecord), a dopasowanie idzie po adresacie (`to:`), nie po
// czasie - jednoznaczne niezaleznie od tego, co juz lezy w skrzynce.
//
// Realny wynik pierwszego prawdziwego zgloszenia w tej sesji: mail wyladowal
// w Spamie (nowy nadawca + zupelnie nowy, nigdy wczesniej niewidziany adres
// odbiorcy = klasyczny sygnal dla filtra antyspamowego) - nie w INBOX.
// Dlatego szukamy w INBOX ORAZ w kazdym folderze, ktorego nazwa wyglada na
// spam/junk (nie zakladamy sztywno "[Gmail]/Spam" - inne konta/dostawcy
// moga nazywac ten folder inaczej).
const SPAM_FOLDER_PATTERN = /spam|junk/i;

async function findFoldersToSearch(client) {
  const folders = await client.list();
  const paths = folders.map(f => f.path);
  const spamFolders = paths.filter(p => SPAM_FOLDER_PATTERN.test(p));
  return ['INBOX', ...spamFolders];
}

// `createClient` jest wstrzykiwalny (domyslnie prawdziwy ImapFlow) - do
// testow jednostkowych bez prawdziwej skrzynki.
// isCancelled: sprawdzane na poczatku kazdej proby (czyli tez zaraz po
// kazdym oczekiwaniu miedzy probami, skoro to jest poczatek petli) - audyt
// 2026-08-21, bez tego "Anuluj" nie mialo tu zadnego efektu, mimo ze reszta
// joba juz reaguje na cancelRequested (patrz jobs.js#takeNext) -
// uzytkownik czekalby az do pelnego timeoutu (domyslnie 3 minuty,
// konfigurowalne wyzej) zanim anulowanie faktycznie cokolwiek by zmienilo
// dla wiersza, ktory akurat czeka na maila.
export async function waitForVarmeroCard({
  imapConfig,
  recipientEmail,
  timeoutMs,
  pollIntervalMs = 5000,
  createClient = () => new ImapFlow({ ...imapConfig, logger: imapConfig?.logger ?? false }),
  isCancelled = () => false
}) {
  if (!recipientEmail) throw new Error('waitForVarmeroCard: brak recipientEmail - dopasowanie po odbiorcy jest wymagane.');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (isCancelled()) throw new CancelledWaitError('Oczekiwanie na mail z karta Varmero przerwane na zadanie uzytkownika.');
    const client = createClient();
    await client.connect();
    try {
      const foldersToSearch = await findFoldersToSearch(client);
      for (const folderPath of foldersToSearch) {
        const lock = await client.getMailboxLock(folderPath);
        try {
          const uids = await client.search({ to: recipientEmail, from: VARMERO_SENDER });
          // Adres odbiorcy jest unikalny per wiersz, wiec nie powinno byc
          // wiecej niz jedno trafienie - mimo to najnowsze najpierw, na
          // wszelki wypadek (np. reczny ponowny test na ten sam adres).
          for (const uid of [...(uids || [])].sort((a, b) => b - a)) {
            const { content } = await client.download(uid, undefined, { uid: true });
            const parsed = await simpleParser(content);
            const attachment = pickCardAttachment(parsed.attachments);
            if (attachment) return { buffer: attachment.content, filename: attachment.filename, folder: folderPath };
          }
        } finally {
          lock.release();
        }
      }
    } finally {
      await client.logout().catch(() => {});
    }
    await sleep(pollIntervalMs);
  }

  throw new NoNewEmailError(`Nie przyszedł mail z kartą Varmero na adres ${recipientEmail} w ciągu ${Math.round(timeoutMs / 1000)}s (sprawdzano INBOX i Spam).`);
}
