# ocr-audytow: `recalibrate-remaining` był całkowitym no-opem — 2 błędy naprawione (2026-07-24)

Właściciel zgłosił, że mechanizm "wykorzystaj sprawdzony adres jako wzór dla pozostałych" nie działa
wcale na żywo: ręczne zaznaczenie pola (np. Telefon) na adresie 1 nie przenosiło się na adres 2/3/4 —
dalej trzeba było zaznaczać to samo pole w każdym adresie. Wcześniejsza "weryfikacja" tego samego dnia
była zrobiona TYLKO przez izolowane wywołania funkcji (`node -e` na `harvestTemplateFields` itd.), nie
przez prawdziwy end-to-end przebieg — stąd nie złapała żadnego z tych błędów.

## Błąd 1 — `server.js`, `/api/ocr/recalibrate-remaining`

Strażnik `alreadyTouched` (chroniący już-przejrzane bloki przed nadpisaniem) sprawdzał
`Object.values(block.fields).some(f => f.resolved)`. Ale pola wyekstrahowane automatycznie z wysoką
pewnością dostają `resolved:true` już przy PIERWSZEJ ekstrakcji (`extract-fields`), zanim użytkownik
w ogóle zobaczy dany blok. Efekt: `alreadyTouched` wychodził `true` dla prawie każdego bloku od razu
po starcie, więc `recalibrate-remaining` zawsze zwracał `updatedBlocks: []`.

**Fix**: nowa flaga NA POZIOMIE BLOKU, `block.userReviewed`, ustawiana wyłącznie wewnątrz
`/api/ocr/resolve-field` i `/api/ocr/mark-field-region` (czyli prawdziwa interakcja użytkownika z TYM
blokiem) — `alreadyTouched` teraz sprawdza `block.userReviewed`, nie stan pojedynczych pól.

## Błąd 2 — `src/templateEngine.js`, `extractFieldsFromTemplate`

Nawet po fixie #1, ręcznie zaznaczone pola (zawsze lądują w `template.textFields`, nigdy w
`groupFields` — patrz `harvestTemplateFields`) dalej traciły podgląd na innych adresach. Pętla po
`textFields` NIE miała fallbacku do własnego regionu wzoru, gdy ekstrakcja regionalna nic konkretnego
nie znalazła — w odróżnieniu od pętli `groupFields` tuż niżej, która już miała
`if (!result.labelBBox && !result.valueBBox) result.valueBBox = rect;`. Konkretnie: statyczna etykieta
formularza jak "Telefon:" istnieje identycznie na każdym adresie, więc `extractTextField`'s
`existsInPageText`-fallback zwracał `found:true` ale BEZ żadnego bboxa (nie `found:false` — pole
wyglądało na "obsłużone", ale nie miało z czego zbudować podglądu).

**Fix**: dodano identyczny fallback do pętli `textFields` (`if (!field.labelBBox && !field.valueBBox)
field.valueBBox = rect;`).

## Weryfikacja (prawdziwa, nie izolowana)

Pełny żywy przebieg Playwright na realnym pliku Kazimierz Biskupi (4 adresy): upload → potwierdzenie
podziału → przegląd 9 pól adresu 1 przez bezpośrednie wywołania tych samych endpointów co UI
(`mark-field-region` + `resolve-field`, w tej samej kolejności co prawdziwy drag+wpisanie+Enter) →
wywołanie `recalibrate-remaining` dokładnie jak robi to klient przy przejściu do kolejnego bloku.
Przed fixem: `updatedBlocks: []`. Po obu fixach: `updatedBlocks` zawierał wszystkie 3 pozostałe bloki,
a 4 ręcznie zaznaczone pola (telefon, udzialGrzejnikowy, izolacjaScianyFundamentowej, izolacjaDachu)
miały `previewUrl` na adresach 2/3/4 — potwierdzone wizualnie (pobrane bezpośrednio z cache-bustingiem,
bo `<img>` w żywej przeglądarce reużywał starego obrazka z tego samego URL-a po ponownym zaznaczeniu).

**Uwaga na przyszłość**: przy debugowaniu drag-and-drop w Playwright na tej aplikacji, syntetyczne
`page.mouse.down/move/up` potrafią wywołać spontaniczny `pointercancel` w trakcie przeciągania (gdy
element woła `setPointerCapture`) — to artefakt CDP/Playwrighta, nie prawdziwy błąd aplikacji. Obejście:
albo wysyłać `new PointerEvent(...)` bezpośrednio przez `page.evaluate`, albo wywoływać docelowy
endpoint wprost przez `fetch()` z poziomu strony.

Stan gita: NIE scommitowane w chwili pisania tej notatki (patrz `mem:core` / czekaj na dalsze kroki
tej samej sesji).
