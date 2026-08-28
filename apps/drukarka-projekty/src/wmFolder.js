const fs = require("fs");
const path = require("path");
const folderMatch = require("./folderMatch");

// Jedyny stały sygnal "to jest kategoria WM" - plik zaczynajacy sie od "WM"
// (np. "WM Pompa ciepla split.docx"). Numeracja/glebokosc folderow NIE jest
// stala miedzy inwestycjami (potwierdzone na Nowe Ostrowy/Strzalkowo/Lowicz -
// patrz plan), wiec nie mozna sie na niej opierac przy wykrywaniu kategorii.
const WM_TITLE_RE = /^WM\b/i;
// Wariant powykonawczy - zawsze ma "dok.pod" (czasem z kropka po "dok", czasem
// bez) zaraz po "WM".
const WM_DOKPOD_RE = /^WM\s*dok\.?\s*pod\b/i;

// Zabezpieczenie przed patologiczna struktura folderow (np. symlink-petla) -
// w praktyce kategorie WM widziane do tej pory sa maks. 2 poziomy glebokie.
const MAX_DEPTH = 6;

function parseLeadingNumber(name) {
  const m = String(name || "").match(/^(\d+)[.\-_ ]+/);
  return m ? Number(m[1]) : null;
}

// Rekurencyjnie znajduje KAZDY folder, ktory bezposrednio zawiera plik "WM ...".
// To jest "kategoria" - niezaleznie od tego, na jakiej glebokosci lezy i czy
// on sam (albo jego rodzic) ma numer w nazwie.
function findCategoryFolders(rootPath, depth = 0, relParts = []) {
  if (depth > MAX_DEPTH) return [];
  let entries;
  try {
    entries = fs.readdirSync(rootPath, { withFileTypes: true });
  } catch (err) {
    // Ten sam problem co w folderMatch.js#scanFilesRecursive: folder WM sam w
    // sobie nieczytelny (dysk sieciowy) nie moze wygladac jak "0 kategorii
    // znaleziono" - to sugerowaloby uzytkownikowi ze folder jest po prostu
    // pusty. Zagniezdzone podfoldery (depth>0) zostaja tolerowane.
    if (depth === 0) {
      throw new Error(`Nie udało się odczytać folderu WM "${rootPath}": ${err.message || err}`);
    }
    return [];
  }

  const files = entries.filter(e => e.isFile()).map(e => e.name);
  const categories = [];
  if (files.some(name => WM_TITLE_RE.test(name))) {
    categories.push({ folderPath: rootPath, relPath: relParts.join("/"), files });
  }

  for (const e of entries) {
    if (e.isDirectory()) {
      categories.push(...findCategoryFolders(path.join(rootPath, e.name), depth + 1, [...relParts, e.name]));
    }
  }
  return categories;
}

function categorySortComparator(a, b) {
  const na = parseLeadingNumber(path.basename(a.relPath));
  const nb = parseLeadingNumber(path.basename(b.relPath));
  if (na !== null && nb !== null) return na - nb;
  if (na !== null) return -1;
  if (nb !== null) return 1;
  return a.relPath.localeCompare(b.relPath, "pl");
}

// Etykieta kategorii do wyswietlenia uzytkownikowi - usuwa wiodacy numer z
// ostatniego segmentu sciezki, zachowuje segmenty nadrzedne (np. przypadek
// Lowicza: "WM/Pompy ciepła/1. Pompa ciepła do c.o. i c.w.u" -> "Pompy ciepła
// / Pompa ciepła do c.o. i c.w.u").
function categoryLabel(relPath) {
  const parts = relPath.split("/").filter(Boolean);
  if (!parts.length) return "(WM)";
  const last = parts[parts.length - 1].replace(/^\d+[.\-_ ]+\s*/, "");
  const parents = parts.slice(0, -1);
  return parents.length ? `${parents.join(" / ")} / ${last}` : last;
}

// Wybiera plik tytulowy danej kategorii - zwykly albo powykonawczy ("dok.pod").
// Gdy istnieje zarowno .pdf jak i .docx (zdarza sie), preferuje .pdf: nie
// edytujemy tresci/daty w tej funkcji, wiec gotowy PDF jest wygodniejszy do
// druku (pozwala wybrac inna niz domyslna drukarke - patrz print-file.ps1).
function pickTitle(files, dokPod) {
  const matches = files.filter(name => dokPod
    ? WM_DOKPOD_RE.test(name)
    : (WM_TITLE_RE.test(name) && !WM_DOKPOD_RE.test(name)));
  if (!matches.length) return null;
  const pdf = matches.find(n => n.toLowerCase().endsWith(".pdf"));
  return pdf || matches[0];
}

// Plik "WM ..." zawsze ma sekcje "Załączniki:" z lista nazw w kolejnosci (bez
// numeracji "nr X" - inny format niz "Załącznik nr N:" w folderMatch.js,
// uzywany przez Opis Techniczny w trybie adresowym). Sekcja konczy sie linia
// "wnioskuję o zgodę..." w tym szablonie (sprawdzone na Nowe Ostrowy i
// Strzałkowie).
function extractZalacznikiList(text) {
  const headerMatch = /Za[łl][ąa]czniki\s*:?/i.exec(text || "");
  if (!headerMatch) return [];
  const afterHeader = text.slice(headerMatch.index + headerMatch[0].length);
  const endMatch = /wnioskuj[ęe]/i.exec(afterHeader);
  const section = endMatch ? afterHeader.slice(0, endMatch.index) : afterHeader;
  return section
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
}

// Glowna funkcja: skanuje folder WM (dowolnej inwestycji) i zwraca plaska,
// uporzadkowana liste wpisow gotowych do przegladu/dodania do kolejki druku
// (ten sam ksztalt {fullPath, label, confidence} co uzywany gdzie indziej w
// tej apce dla trybu adresowego).
async function scanWmFolder(wmRootPath, { powykonawczy = false } = {}) {
  const categories = findCategoryFolders(wmRootPath).sort(categorySortComparator);

  const items = [];
  const warnings = [];
  let missingCount = 0;

  for (const cat of categories) {
    const label = categoryLabel(cat.relPath);
    const titleZwykly = pickTitle(cat.files, false);
    const titleDokPod = pickTitle(cat.files, true);
    const chosenTitle = powykonawczy ? titleDokPod : titleZwykly;

    if (chosenTitle) {
      items.push({
        fullPath: path.join(cat.folderPath, chosenTitle),
        label: `${label}: strona tytułowa${powykonawczy ? " (powykonawcza)" : ""}`,
        confidence: "pewne",
        category: label,
        categoryPath: cat.relPath
      });
    } else {
      missingCount += 1;
      items.push({
        fullPath: null,
        label: `${label}: strona tytułowa${powykonawczy ? " powykonawcza (WM dok.pod)" : ""} - BRAK PLIKU`,
        confidence: "brak",
        category: label,
        categoryPath: cat.relPath
      });
    }

    let zalacznikiList = [];
    if (chosenTitle) {
      const isDocx = chosenTitle.toLowerCase().endsWith(".docx");
      try {
        const text = await folderMatch.extractText(cat.folderPath, isDocx ? chosenTitle : null, isDocx ? null : chosenTitle);
        zalacznikiList = extractZalacznikiList(text);
      } catch (err) {
        // Awaria odczytu strony tytulowej (uszkodzony/zabezpieczony PDF, DOCX
        // chwilowo niedostepny na dysku sieciowym) dawala puste zalacznikiList,
        // czyli DOKLADNIE to samo co "strona tytulowa nie ma listy Zalacznikow"
        // - countMatches ponizej sie wylaczal i etykiety cicho spadaly na nazwy
        // plikow. KOLEJNOSC druku wynika z numeru w nazwie pliku i nie zmienia
        // sie; degraduje sie wylacznie ETYKIETOWANIE, wiec tylko to sygnalizujemy.
        zalacznikiList = [];
        warnings.push(`${label}: nie udalo sie odczytac listy Zalacznikow ze strony tytulowej "${chosenTitle}" (${err?.message || err}). Etykiety pochodza z nazw plikow; kolejnosc (wg numeru w nazwie) jest bez zmian.`);
      }
    }

    const attachmentFiles = cat.files.filter(name => !WM_TITLE_RE.test(name) && name.toLowerCase() !== "thumbs.db");
    const numbered = [];
    const unnumbered = [];
    for (const name of attachmentFiles) {
      const num = parseLeadingNumber(name);
      if (num !== null) numbered.push({ name, num });
      else unnumbered.push({ name });
    }
    numbered.sort((a, b) => a.num - b.num);

    // Numer w nazwie pliku okazal sie w 100% zgodny z kolejnoscia z listy
    // Załączników na wszystkich sprawdzonych realnych przykladach (Nowe
    // Ostrowy/Strzałkowo/Łowicz) - to on decyduje o KOLEJNOSCI druku, i to
    // jest "pewne" niezaleznie od tego, czy poda sie dopasowac ladna etykiete.
    // Dopasowanie tekstu z listy do nazw plikow po slowach kluczowych zawodzi
    // w praktyce (np. "Etykieta energetyczna" <-> plik "ERP ...pdf" - zero
    // wspolnych slow), a NORMALNA sytuacja to jedna pozycja z listy = wiele
    // plikow (np. "Certyfikat HP Keymark - oryginał" = 3 pliki, po jednym na
    // model urzadzenia) - to NIE jest blad wymagajacy sprawdzenia, tylko
    // brak mozliwosci wyciagniecia ladnej etykiety z tekstu. Etykiete z listy
    // (pozycyjnie) dajemy TYLKO gdy liczba pozycji dokladnie sie zgadza z
    // liczba ponumerowanych plikow - w przeciwnym razie po prostu nazwa pliku.
    const countMatches = zalacznikiList.length > 0 && zalacznikiList.length === numbered.length;
    numbered.forEach((entry, idx) => {
      items.push({
        fullPath: path.join(cat.folderPath, entry.name),
        label: countMatches ? `${label}: ${zalacznikiList[idx]}` : `${label}: ${entry.name}`,
        confidence: countMatches ? "pewne (dopasowane z listy Załączników)" : "pewne (kolejność wg numeru w nazwie pliku)",
        category: label,
        categoryPath: cat.relPath
      });
    });
    for (const entry of unnumbered) {
      items.push({
        fullPath: path.join(cat.folderPath, entry.name),
        label: `${label}: ${entry.name} - brak numeru w nazwie, sprawdź kolejność ręcznie`,
        confidence: "brak numeru - sprawdź ręcznie",
        category: label,
        categoryPath: cat.relPath
      });
    }
  }

  return { items, missingCount, categoriesFound: categories.length, folderReadWarnings: warnings.length ? warnings : undefined };
}

module.exports = { scanWmFolder, extractZalacznikiList, parseLeadingNumber, categoryLabel, findCategoryFolders };
