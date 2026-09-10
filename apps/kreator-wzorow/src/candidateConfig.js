// Walidacja nakladania sie zakresow kandydatow PRZED buildem (sekcja 34
// specyfikacji Kreatora - "OVERLAP RANGES"). Dziala na plaskiej liscie
// pozycji (start/end w tej samej Story dokumentu) wyliczonej przez
// server.js z wynikow skanu (src/excelWorkbook.js nie ma tu nic do rzeczy -
// to geometria dokumentu Word, nie danych Excela) - modul jest CELOWO czysty
// (bez zaleznosci od Worda/COM), zeby dalo sie go przetestowac bez
// zainstalowanego Office (patrz sekcja 36).
'use strict';

// entries: [{ id, start, end, storyKey, kind }], kind: 'field' | 'block' | 'manual'.
// Dwa wpisy z ROZNYCH storyKey (np. glowny tekst vs stopka) nigdy nie
// "nakladaja sie" - porownujemy tylko w obrebie tej samej Story.
function rangesOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

function contains(outer, inner) {
  return outer.start <= inner.start && inner.end <= outer.end;
}

// Zwraca liste bledow (pscustomobject-podobnych { message, candidateIds }).
// Zasady (sekcja 34):
// - field CALKOWICIE wewnatrz dokladnie jednego blocku -> OK (jednoznaczne:
//   blok zostaje = field dziala, blok usuniety = field znika razem z nim).
// - field czesciowo nakladajacy sie z blockiem (ani rozlaczny, ani w pelni
//   zawarty) -> BLAD.
// - dwa bloki (z ROZNYCH blockId) czesciowo nakladajace sie (bez relacji
//   zawierania) -> BLAD.
// - manual nakladajacy sie z field/block (poza pelnym rozlaczeniem) -> BLAD.
function validateOverlaps(entries) {
  const errors = [];
  const byStory = new Map();
  for (const entry of entries) {
    const key = entry.storyKey || 'main';
    if (!byStory.has(key)) byStory.set(key, []);
    byStory.get(key).push(entry);
  }

  for (const [, group] of byStory) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i];
        const b = group[j];
        if (!rangesOverlap(a, b)) continue;
        if (contains(a, b) || contains(b, a)) {
          // Zawieranie jest dozwolone WYLACZNIE dla field-w-block. Dwa
          // rozne bloki (nawet jeden w pelni w drugim) albo manual w
          // czymkolwiek to zawsze blad - nie ma dla nich jednoznacznego
          // "co sie dzieje, gdy zewnetrzny zakres zostaje/znika".
          const isFieldInsideBlock = (a.kind === 'field' && b.kind === 'block' && contains(b, a))
            || (b.kind === 'field' && a.kind === 'block' && contains(a, b));
          if (isFieldInsideBlock) continue;
        }
        errors.push({
          message: `Kandydaci "${a.id}" i "${b.id}" nakladaja sie w dokumencie w niejednoznaczny sposob (${a.kind} vs ${b.kind}) - popraw konfiguracje przed buildem.`,
          candidateIds: [a.id, b.id]
        });
      }
    }
  }
  return errors;
}

module.exports = { validateOverlaps, rangesOverlap, contains };
