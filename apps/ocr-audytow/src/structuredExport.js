// Eksport strukturalny (JSON, per adres) - Faza 3 planu przygotowania danych
// OCR pod przyszly, osobny silnik OZC wg PN-EN 12831-1 (2026-08-07,
// C:\Users\Piotr.Cyniak\.claude\plans\sparkling-doodling-prism.md - silnik
// swiadomie NIE jest budowany teraz, na wyrazna prosbe wlasciciela ("nie no
// nie licz tego") - to tylko przygotowanie danych, zeby kiedys dalo sie go
// podlaczyc bez recznego przepisywania).
//
// W odroznieniu od buildRowValues (tabelaAdresowaColumns.js), ktory zwraca
// string do komorki Excela DLA CZLOWIEKA (np. "Wylewka betonowa, 8cm"), ta
// funkcja zwraca dane typowane: liczby jako Number (nie string do parsowania
// wstecz), materialy jako stabilny materialKey (nie polska etykieta z
// formularza) - patrz fieldExtraction.js#FIELD_DEFS/toFieldResult.
//
// Zero wlasnej logiki filtrowania/bramki jakosci tutaj CELOWO - polega w
// calosci na tym, ze materialKey/optionKey/thicknessCm/parsedNumber sa przez
// toFieldResult ustawiane WYLACZNIE dla pol, ktore przeszly needsReview i nie
// sa ostrzezeniem "Sprzeczne odczyty: ..." (patrz tam), a server.js#/api/ocr/finalize
// i tak juz odrzuca CALA paczke, jesli KTOKOLWIEK plik ma choc jedno pole
// needsReview/nieresolved (`unresolved` w finalize) - w momencie, gdy ta
// funkcja jest wywolywana, kazde pole jest wiec juz gotowe.
function buildStructuredRow(fields, meta = {}) {
  const row = { ...meta };
  for (const [key, field] of Object.entries(fields || {})) {
    if (!field || !field.value) continue;
    if (field.materialKey) {
      row[key] = { materialKey: field.materialKey, thicknessCm: Number.isFinite(field.thicknessCm) ? field.thicknessCm : null, label: field.value };
    } else if (field.optionKey) {
      row[key] = { optionKey: field.optionKey, label: field.value };
    } else if (typeof field.parsedNumber === 'number') {
      row[key] = field.parsedNumber;
    } else {
      row[key] = field.value;
    }
  }
  return row;
}

module.exports = { buildStructuredRow };
