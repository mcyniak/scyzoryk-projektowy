// Wyliczanie folderu "wzor" (szablony/wzorce dla klienta) z podanego
// rootPath inwestycji - wspoldzielone miedzy apps/karty-katalogowe
// (oryginalny wlasciciel tej logiki - PDF-y specyfikacji produktowych
// dopasowywane po UID) i apps/pipeline (Faza "Pipeline inwestycji" -
// potwierdzone przez wlasciciela 2026-08-21, ze TEN SAM folder "wzor" ma tez
// szablony Word (.docx) i tabele Excel do dokumentow seryjnych, wiec
// pipeline moze go wyliczyc z juz podanego rootPathSolary/rootPathPompy
// zamiast prosic o kolejna, osobna sciezke).
//
// CELOWO bez zaleznosci npm (tylko wbudowane fs/path) - patrz komentarz w
// lib/investmentAddressTable.js o tym samym ograniczeniu dla lib/.
const fs = require('fs');
const path = require('path');

// Solary/Kolektory: dwie mozliwe nazwy folderu wprost pod rootPath - "karty"
// (czestsza konwencja) albo "wzor" (starsza/alternatywna nazwa). Zwraca
// "karty" jako domyslna sciezke do komunikatu bledu, jesli zaden nie istnieje.
function znajdzFolderZrodlowySolarow(rootPath) {
  const karty = path.join(rootPath, 'karty');
  if (fs.existsSync(karty)) return karty;
  const wzor = path.join(rootPath, 'wzór');
  if (fs.existsSync(wzor)) return wzor;
  return karty;
}

// Pompy: rootPath to caly folder inwestycji, z podfolderem "PC powietrzne"
// albo "PC" (starsza nazwa), a wewnatrz tego dopiero "wzor"/"Projekty".
function znajdzFolderyPomp(rootPath) {
  const warianty = ['PC powietrzne', 'PC'];
  for (const folder of warianty) {
    const wzorDir = path.join(rootPath, folder, 'wzór');
    if (fs.existsSync(wzorDir)) return { wzorDir, projektyDir: path.join(rootPath, folder, 'Projekty') };
  }
  return { wzorDir: path.join(rootPath, warianty[0], 'wzór'), projektyDir: path.join(rootPath, warianty[0], 'Projekty') };
}

module.exports = { znajdzFolderZrodlowySolarow, znajdzFolderyPomp };
