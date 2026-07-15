# Moduły apps/* — porty i przeznaczenie

| Port | Folder | Rola |
|---|---|---|
| 3000 | root (`server.js`) | Panel/supervisor, tylko linkuje do modułów |
| 3001 | `apps/drukarka` | Kolejka wydruku plików PDF/DOC/DOCX, wybór drukarki |
| 3002 | `apps/pieczatki-pdf` | Nakładanie pieczątek na PDF |
| 3003 | `apps/formularze-ecodan` | Generuje raporty doboru pomp ciepła przez zewnętrzny
  portal producenta (`my-ecodan.me`) sterowany Playwrightem |
| 3004 | `apps/dokumenty-seryjne` | Korespondencja seryjna: folder wzorów (DOCX+PDF,
  warianty wg mocy/modelu) + Excel → osobny folder per adres z wygenerowanymi/
  skopiowanymi dokumentami. Rdzeń logiki: `src/templateScan.js` (rozpoznawanie
  typu/wariantu wzoru) i `src/folderGeneration.js` (fuzzy kolumny, plan generowania).
  Generowanie DOCX idzie przez `scripts/mailmerge-to-pdf.ps1` (Word COM), jeden
  wiersz na wywołanie PowerShell — patrz `mem:windows_automation`. |
| 3005 | `apps/wnioski-powykonawcze` | Wiele DOCX → PDF z datą dokumentacji |
| 3006 | `apps/karty-katalogowe` | Kopiuje karty katalogowe do folderów klientów wg
  kolumny UID (format `N/rozmiar`, ostatnia liczba = rozmiar zestawu) |
| 3010 | `apps/drukarka-projekty` | Najbardziej rozbudowany moduł: dla adresu z Excela
  samo znajduje folder projektu, czyta listę załączników z prawdziwego Opisu
  technicznego, dopasowuje pliki, łączy w PDF, drukuje. Rdzeń: `src/folderMatch.js`.
  Współdzielony wzorzec izolacji sesji (`lib/sessionStore.js`) i drukowania
  (`scripts/print-file.ps1`) — OD 2026-07-15 NIEAKTUALNE: skonsolidowane do wspólnego `lib/printing.js` +
  `lib/printing/print-file.ps1` (patrz `mem:windows_automation`), `apps/drukarka-projekty/scripts/`
  jest teraz pusty. |

Foldery klientów na dysku (poza tym repo, na `G:\...`) mają konwencję nazewnictwa
`"{numer} - {adres}"` — kilka modułów (drukarka-projekty, dokumenty-seryjne) celowo
tworzy/szuka folderów w TEJ SAMEJ konwencji, żeby się wzajemnie widziały.
