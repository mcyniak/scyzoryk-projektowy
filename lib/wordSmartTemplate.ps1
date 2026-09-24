# Wspoldzielony helper PowerShell dla Smart Template (Kreator wzorow
# seryjnych) - dot-source'owany przez
# apps/dokumenty-seryjne/scripts/mailmerge-to-pdf.ps1, gdy uruchamiany z
# -SmartTemplateMode (patrz komentarz tam). Zyje w lib/, nie w konkretnej
# apce, bo lib/ jest jedynym miejscem dzielonym miedzy child apps w tym repo
# (patrz CLAUDE.md).
#
# Apply-ScyzorykSmartBlocks realizuje "smart blocks" z manifestu Kreatora:
# dlugie warianty tresci (caly akapit/lista/tabela z zachowanym
# formatowaniem) sa w gotowym wzorze opakowane w Bookmark o nazwie
# SCYB_<hex>. lib/smartTemplateRules.js#evaluateSmartRecord juz PRZED
# uruchomieniem Worda wyliczyl, ktore bookmarki maja zostac (warunek
# spelniony), a ktore znikna razem z cala trescia (warunek niespelniony) -
# wynik jest zapisany w rekordzie jako wlasciwosc `_scyBlocksJson`
# (JSON: { "SCYB_xxx": true/false, ... }). Ta funkcja tylko WYKONUJE juz
# podjeta decyzje w samym dokumencie Worda - nie ocenia warunkow.
#
# UWAGA (audyt 2026-09-10, "0 kandydatow" na produkcji): Find-ScyzorykMarkedCandidates
# ponizej byla PRZED tym audytem oparta na dwoch wlasciwosciach Word COM Find,
# ktore w rzeczywistosci NIE ISTNIEJA na obiekcie Find:
#   - Find.Font.HighlightColorIndex  -> rzuca "The property 'HighlightColorIndex'
#     cannot be found on this object" (zweryfikowane live na Word COM)
#   - Find.Shading                    -> rzuca "The property 'Shading' cannot
#     be found on this object" (Find NIE MA wlasciwosci Shading - jest ona
#     tylko na Find.Font.Shading i Find.ParagraphFormat.Shading)
# Oba wyjatki byly polykane przez `catch { break }`, co zamienialo KAZDE
# wywolanie w cichy "0 kandydatow" bez zadnego bledu. Poprawne, zweryfikowane
# live mechanizmy (patrz komentarze przy kazdej sekcji nizej):
#   - highlight        -> Find.Highlight = $true (dowolny highlight), potem
#                          doprecyzowanie DOKLADNEGO koloru przez odczyt
#                          Range.HighlightColorIndex i reczny "character walk"
#                          granicy (Find.Highlight nie rozroznia kolorow - dwa
#                          sasiadujace fragmenty roznych kolorow scalaja sie w
#                          jeden "surowy" match, wiec zawsze doprecyzowujemy
#                          faktyczna granice tego samego koloru zanim uznamy
#                          fragment za kandydata).
#   - run/font shading  -> Find.Font.Shading.BackgroundPatternColor (NIE
#                          Find.Shading - ta wlasciwosc nie istnieje).
#   - paragraph shading -> Find.ParagraphFormat.Shading.BackgroundPatternColor
#                          (osobny mechanizm od run shading - dopasowany Range
#                          OBEJMUJE koncowy znak akapitu, patrz komentarz przy
#                          Find-ScyzorykParagraphShading).
#   - cell shading      -> Find nie ma odpowiednika dla cieniowania calej
#                          komorki - iterujemy Table.Range.Cells (NIE
#                          Rows.Cells, patrz istniejacy w repo udokumentowany
#                          problem ze scalonymi komorkami) i porownujemy
#                          Cell.Shading.BackgroundPatternColor wprost.
# Druga, niezalezna poprawka z tego samego audytu: StoryRanges.NextStoryRange
# NIE laczy roznych TYPOW story (np. main -> header) - laczy tylko wielokrotne
# wystapienia TEGO SAMEGO typu (np. wiele sekcji z roznymi naglowkami).
# Wlasciwy sposob dotarcia do wszystkich obecnych typow story to iteracja po
# kolekcji `doc.StoryRanges` (kazdy element = inny typ), a NASTEPNIE
# NextStoryRange w obrebie KAZDEGO z nich (zeby zlapac wielokrotne wystapienia
# tego samego typu). Poprzedni kod zaczynal tylko od Item(1) (main) i probowal
# NextStoryRange, co w praktyce nigdy nie docieralo do header/footer.
# Trzecia poprawka: `Document.Range(start, end)` adresuje WYLACZNIE story
# "main" - kazda inna story (header/footer/footnote/endnote/textframe) ma
# WLASNA, niezalezna numeracje Start/End zaczynajaca sie od 0 (zweryfikowane
# live: dwa rozne shape'y z osobnym tekstem maja OBA Start=0 End=10 mimo ze to
# fizycznie inne miejsca w dokumencie). Dlatego kandydat spoza "main" musi byc
# jednoznacznie zlokalizowany przez (storyType, chainIndex) - a dla shape'ow
# (TextFrame, story=5) dodatkowo przez shapeIndex, bo tam nawet story-per-story
# numeracja sie powtarza miedzy roznymi shape'ami. `storyKey` ponizej jest wiec
# stringiem UNIKALNYM na caly dokument (np. "header#0", "textframe#2"), nie
# samym samym ogolnym "header" - patrz Get-ScyzorykUniqueStoryKey.
# Czwarta poprawka: Find wewnatrz Shape.TextFrame.TextRange (story=5) NIE
# DZIALA w ogole (Find.Execute() zawsze zwraca $false, nawet gdy
# TextRange.HighlightColorIndex jednoznacznie potwierdza obecnosc highlightu -
# zweryfikowane live, znany, udokumentowany limit automatyzacji COM dla
# tekstu w ksztaltach). Dla TextFrame/textbox skanujemy więc BEZ Find, recznym
# "character walk" po calym TextRange (dokladnie tak samo jak fallback dla
# run shading, patrz Get-ScyzorykCharWalkRanges).

Set-StrictMode -Version Latest

$script:ScyzorykHighlightMap = @{
  black      = @{ index = 1;  hex = '#000000' }
  blue       = @{ index = 2;  hex = '#0000FF' }
  cyan       = @{ index = 3;  hex = '#00FFFF' }
  brightgreen= @{ index = 4;  hex = '#00FF00' }
  pink       = @{ index = 5;  hex = '#FF00FF' }
  red        = @{ index = 6;  hex = '#FF0000' }
  yellow     = @{ index = 7;  hex = '#FFFF00' }
  white      = @{ index = 8;  hex = '#FFFFFF' }
  darkblue   = @{ index = 9;  hex = '#00008B' }
  teal       = @{ index = 10; hex = '#008080' }
  green      = @{ index = 11; hex = '#008000' }
  violet     = @{ index = 12; hex = '#800080' }
  darkred    = @{ index = 13; hex = '#8B0000' }
  darkyellow = @{ index = 14; hex = '#808000' }
  gray50     = @{ index = 15; hex = '#808080' }
  gray25     = @{ index = 16; hex = '#C0C0C0' }
}
# OOXML w:highlight w:val="..." -> klucz powyzszej mapy (Word zapisuje
# "darkGreen" dla WdColorIndex.wdGreen, "green" dla wdBrightGreen, itd.).
$script:ScyzorykOoxmlHighlightToKey = @{
  black = 'black'; blue = 'blue'; cyan = 'cyan'; darkblue = 'darkblue'
  darkcyan = 'teal'; darkgray = 'gray50'; darkgreen = 'green'
  darkmagenta = 'violet'; darkred = 'darkred'; darkyellow = 'darkyellow'
  green = 'brightgreen'; lightgray = 'gray25'; magenta = 'pink'
  red = 'red'; white = 'white'; yellow = 'yellow'
}
# Odwrotnosc $script:ScyzorykHighlightMap (WdColorIndex numeryczny -> nasz
# wewnetrzny klucz) - potrzebne, bo po znalezieniu highlightu przez
# Find.Highlight = $true jedynym sposobem ustalenia KTORY to kolor jest
# odczyt Range.HighlightColorIndex znalezionego zakresu.
$script:ScyzorykHighlightIndexToKey = @{}
foreach ($kv in $script:ScyzorykHighlightMap.GetEnumerator()) {
  $script:ScyzorykHighlightIndexToKey[[int]$kv.Value.index] = $kv.Key
}

# WdStoryType, ktore NIGDY nie zawieraja realnej tresci uzytkownika - to sa
# wewnetrzne separatory/notki przypisow/koncowek, ktore Word utrzymuje
# automatycznie w kazdym dokumencie (nawet bez zadnego przypisu). Pomijamy je
# przy skanowaniu, zeby nie marnowac czasu i nie tworzyc bezsensownych
# kandydatow.
$script:ScyzorykSkippableStoryTypes = @(12, 13, 14, 15, 16, 17)

function ConvertTo-ScyzorykHighlightKey([string]$ooxmlName) {
  $norm = ([string]$ooxmlName).ToLowerInvariant()
  if ($script:ScyzorykOoxmlHighlightToKey.ContainsKey($norm)) { return $script:ScyzorykOoxmlHighlightToKey[$norm] }
  return $null
}

# OLE COLORREF (jak z Range.Shading.BackgroundPatternColor) trzyma kolor jako
# 0x00BBGGRR (odwrotna kolejnosc bajtow niz zwykly RGB hex) - stad rozbite
# bitowe wyluskanie R/G/B przed sklejeniem "RRGGBB".
function ConvertTo-ScyzorykRgbHex([long]$oleColor) {
  if ($oleColor -lt 0) { return $null } # wdColorAutomatic (-16777216) = brak jawnego koloru, nie oznaczenie.
  $r = $oleColor -band 0xFF
  $g = ($oleColor -shr 8) -band 0xFF
  $b = ($oleColor -shr 16) -band 0xFF
  return ('{0:X2}{1:X2}{2:X2}' -f $r, $g, $b)
}

# Odwrotnosc ConvertTo-ScyzorykRgbHex - "RRGGBB" -> OLE COLORREF (0x00BBGGRR),
# dokladnie to, czego oczekuja Find.Font.Shading/ParagraphFormat.Shading/
# Cell.Shading.BackgroundPatternColor.
function ConvertTo-ScyzorykOleColor([string]$hex) {
  $r = [Convert]::ToInt32($hex.Substring(0, 2), 16)
  $g = [Convert]::ToInt32($hex.Substring(2, 2), 16)
  $b = [Convert]::ToInt32($hex.Substring(4, 2), 16)
  return ($r -bor ($g -shl 8) -bor ($b -shl 16))
}

# Ujednolica bialy tekst do porownan fingerprintu (sekcja 9 audytu napraw-
# czego: "znormalizowane before/after") - usuwa znaki koncowe akapitu/komorki
# i zwija wielokrotne biale znaki, zeby przypadkowa roznica w otaczajacych
# spacjach nie generowala falszywego "wzor sie zmienil".
function Get-ScyzorykNormalizedText([string]$text) {
  if ([string]::IsNullOrEmpty($text)) { return '' }
  $t = $text -replace '[\r\a\v\f]', ' '
  $t = $t -replace '\s+', ' '
  return $t.Trim()
}

# Nazwa Story do wyswietlenia (bez indeksu/shape'a - patrz
# Get-ScyzorykUniqueStoryKey dla klucza UNIKALNEGO w calym dokumencie).
# WdStoryType (zweryfikowane live na Word COM - patrz komentarz audytu na
# gorze pliku): 1=main, 2=footnotes, 3=endnotes, 4=comments, 5=textframe,
# 6=header(parzyste strony), 7=header(glowny), 8=footer(parzyste strony),
# 9=footer(glowny), 10=header(pierwsza strona), 11=footer(pierwsza strona),
# 12-17=separatory/notki przypisow - pomijane (patrz ScyzorykSkippableStoryTypes).
function Get-ScyzorykStoryKey([int]$storyType) {
  switch ($storyType) {
    1  { return 'main' }
    2  { return 'footnotes' }
    3  { return 'endnotes' }
    4  { return 'comments' }
    5  { return 'textframe' }
    6  { return 'header' }
    7  { return 'header' }
    8  { return 'footer' }
    9  { return 'footer' }
    10 { return 'header' }
    11 { return 'footer' }
    default { return "story$storyType" }
  }
}

# Klucz UNIKALNY w calym dokumencie dla danej instancji story - "main" jest
# zawsze jedna, ale "header"/"footer" moga wystapic wiele razy (rozne sekcje)
# i "textframe" moze wystapic raz na kazdy shape - wszystkie maja WLASNA,
# od-zera numeracje Start/End (patrz komentarz audytu na gorze pliku), wiec
# sam storyKey + start/end NIE WYSTARCZA do jednoznacznej lokalizacji.
function Get-ScyzorykUniqueStoryKey([string]$storyKey, [int]$chainIndex, [Nullable[int]]$shapeIndex) {
  if ($storyKey -eq 'textframe') { return "textframe#$shapeIndex" }
  if ($storyKey -eq 'main') { return 'main' }
  return "$storyKey#$chainIndex"
}

# Zwraca liste WSZYSTKICH obecnych instancji story w dokumencie (jeden wpis
# na kazde polaczenie StoryRanges-kolekcja + NextStoryRange-lancuch), z
# poprawnym chainIndex. Story typu 5 (textframe) jest CELOWO pomijana tutaj -
# ma wlasny, oddzielny mechanizm skanowania przez doc.Shapes (patrz komentarz
# audytu: Find nie dziala w TextFrame, a numeracja Start/End koliduje miedzy
# shape'ami, wiec potrzeba tam shapeIndex, nie chainIndex).
function Get-ScyzorykStoryInstances($doc) {
  $instances = New-Object System.Collections.Generic.List[object]
  foreach ($story in $doc.StoryRanges) {
    $storyType = [int]$story.StoryType
    if ($storyType -eq 5) { continue }
    if ($script:ScyzorykSkippableStoryTypes -contains $storyType) { continue }
    $chainIndex = 0
    $current = $story
    while ($null -ne $current) {
      $instances.Add([pscustomobject]@{
        Range = $current
        StoryType = $storyType
        ChainIndex = $chainIndex
        StoryKey = Get-ScyzorykUniqueStoryKey (Get-ScyzorykStoryKey $storyType) $chainIndex $null
      }) | Out-Null
      $chainIndex++
      try { $current = $current.NextStoryRange } catch { $current = $null }
    }
  }
  return $instances
}

# Rekonstruuje Range dla ZAPISANEJ (z poprzedniej sesji Word COM) pozycji
# story-lokalnej - uzywane WYLACZNIE przez build-template.ps1 do
# przeprowadzenia mutacji. NIGDY nie uzywac $doc.Range(start,end) dla innej
# story niz "main" (patrz komentarz audytu na gorze pliku) - ta funkcja
# najpierw lokalizuje wlasciwy obiekt Range danej story/shape'a, DOPIERO
# potem zawęza go do zadanych wspolrzednych lokalnych przez ustawienie
# .Start/.End na duplikacie (co jest bezpieczne i story-scoped, w
# przeciwienstwie do $doc.Range()).
function Get-ScyzorykStoryRangeCopy($doc, [string]$storyKey, [int]$storyType, [int]$chainIndex, [Nullable[int]]$shapeIndex) {
  if ($storyKey -eq 'main' -or $storyType -eq 1) {
    return $doc.StoryRanges.Item(1).Duplicate
  }
  if ($storyType -eq 5 -or $null -ne $shapeIndex) {
    if ($null -eq $shapeIndex) { throw "Brak shapeIndex dla story typu textframe." }
    return $doc.Shapes.Item($shapeIndex).TextFrame.TextRange.Duplicate
  }
  foreach ($story in $doc.StoryRanges) {
    if ([int]$story.StoryType -ne $storyType) { continue }
    $idx = 0
    $current = $story
    while ($null -ne $current) {
      if ($idx -eq $chainIndex) { return $current.Duplicate }
      $idx++
      try { $current = $current.NextStoryRange } catch { $current = $null }
    }
  }
  throw "Nie znaleziono story typu $storyType (chainIndex=$chainIndex) w dokumencie - wzor mogl zmienic strukture sekcji/naglowkow od czasu skanowania."
}

# Zwraca faktyczny obiekt Cell (NIE Range) dla zapisanych (tableOrdinal,
# cellOrdinal) w danej story - wymagane WYLACZNIE do czyszczenia cieniowania
# calej komorki (Cell.Shading). Zweryfikowane live (audyt 2026-09-10):
# ustawienie .Shading.BackgroundPatternColor na CZESCIOWYM zakresie wewnatrz
# komorki (np. samej tresci pola po wstawieniu MERGEFIELD) jest CICHYM NO-OPEM
# dla cieniowania calej komorki - w przeciwienstwie do ParagraphFormat.Shading
# (ktore poprawnie propaguje sie z dowolnego czesciowego zakresu na caly
# akapit), Cell.Shading wymaga albo PELNEGO Cell.Range, albo bezposrednio
# samego obiektu Cell. Dlatego cell-shading candidates niosa tableOrdinal/
# cellOrdinal (kolejnosc identyczna jak w Find-ScyzorykCellShadingCandidates -
# story.Tables w kolejnosci, potem Table.Range.Cells w kolejnosci), zeby
# build-template.ps1 mogl je tu odtworzyc DOKLADNIE tym samym mechanizmem.
function Get-ScyzorykCellByOrdinal($storyRange, [int]$tableOrdinal, [int]$cellOrdinal) {
  $t = 0
  foreach ($table in $storyRange.Tables) {
    $t++
    if ($t -ne $tableOrdinal) { continue }
    $c = 0
    foreach ($cell in $table.Range.Cells) {
      $c++
      if ($c -eq $cellOrdinal) { return $cell }
    }
  }
  throw "Nie znaleziono komorki tabeli (tableOrdinal=$tableOrdinal, cellOrdinal=$cellOrdinal) - struktura tabeli mogla sie zmienic od czasu skanowania."
}

# Reczny "character walk" - fallback dla miejsc, gdzie Word Find nie dziala
# (TextFrame/textbox, patrz komentarz audytu) albo gdzie potrzeba
# doprecyzowac DOKLADNA granice tego samego formatu wewnatrz szerszego
# "surowego" dopasowania Find (rozne kolory highlight/shading stykajace sie
# bez przerwy - patrz audyt sekcja "highlight"). $GetValue dostaje
# jednoznakowy Range i zwraca porownywalna wartosc (np. HighlightColorIndex
# albo Shading.BackgroundPatternColor); sasiadujace znaki o tej samej
# wartosci sa scalane w jeden ciagly zakres.
function Get-ScyzorykCharWalkRanges($storyRange, [scriptblock]$GetValue, [scriptblock]$IsWanted) {
  $ranges = New-Object System.Collections.Generic.List[object]
  $start = $storyRange.Start
  $end = $storyRange.End
  $pos = $start
  $guard = 0
  while ($pos -lt $end -and $guard -lt 200000) {
    $guard++
    $probe = $storyRange.Duplicate
    $probe.Start = $pos
    $probe.End = [Math]::Min($pos + 1, $end)
    $value = & $GetValue $probe
    if (& $IsWanted $value) {
      $rangeStart = $pos
      $rangeEnd = $pos + 1
      while ($rangeEnd -lt $end) {
        $next = $storyRange.Duplicate
        $next.Start = $rangeEnd
        $next.End = [Math]::Min($rangeEnd + 1, $end)
        $nextValue = & $GetValue $next
        if ($nextValue -ne $value) { break }
        $rangeEnd++
      }
      $matchRange = $storyRange.Duplicate
      $matchRange.Start = $rangeStart
      $matchRange.End = $rangeEnd
      $ranges.Add([pscustomobject]@{ Range = $matchRange; Value = $value }) | Out-Null
      $pos = $rangeEnd
    } else {
      $pos++
    }
  }
  return $ranges
}

function New-ScyzorykCandidate {
  param(
    $ContainerRange,
    $ContentRange,
    [string]$StoryKey,
    [int]$StoryType,
    [int]$ChainIndex,
    [Nullable[int]]$ShapeIndex,
    [string]$Kind,
    [string]$ContainerKind,
    [string]$RawColor,
    [string]$DisplayColor,
    [string]$PaletteKey,
    [int]$Ordinal,
    [Nullable[int]]$TableOrdinal,
    [Nullable[int]]$CellOrdinal
  )
  $text = ''
  try { $text = [string]$ContentRange.Text } catch {}
  $beforeText = ''
  $afterText = ''
  try {
    $beforeRange = $ContentRange.Duplicate
    $beforeStart = [Math]::Max(0, $ContentRange.Start - 80)
    $beforeRange.Start = $beforeStart
    $beforeRange.End = $ContentRange.Start
    $beforeText = [string]$beforeRange.Text
  } catch {}
  try {
    $afterRange = $ContentRange.Duplicate
    $storyEnd = $ContentRange.StoryLength - 1
    $afterEnd = [Math]::Min($storyEnd, $ContentRange.End + 80)
    $afterRange.Start = $ContentRange.End
    $afterRange.End = $afterEnd
    $afterText = [string]$afterRange.Text
  } catch {}

  $inTable = $false
  try { $inTable = [bool]$ContentRange.Information(12) } catch {} # wdWithInTable = 12
  $page = 1
  try { $page = [int]$ContentRange.Information(3) } catch {} # wdActiveEndPageNumber = 3

  if (-not $ContainerKind) { $ContainerKind = if ($inTable) { 'tableCell' } else { 'paragraph' } }

  # Fingerprint (sekcja 9 audytu naprawczego): oparty na tresci i stabilnym
  # kontekscie, NIE na samym ordinal - jesli kolejnosc mechanizmow skanowania
  # kiedykolwiek sie zmieni, fingerprint nadal jednoznacznie identyfikuje TEN
  # SAM fragment po tresci, a nie po pozycji w liscie.
  $normBefore = Get-ScyzorykNormalizedText $beforeText
  $normAfter = Get-ScyzorykNormalizedText $afterText
  $fingerprintSource = "$StoryType|$PaletteKey|$Kind|$text|$normBefore|$normAfter|$ContainerKind"
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hashBytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($fingerprintSource))
  $fingerprint = -join ($hashBytes | ForEach-Object { $_.ToString('x2') })

  return [pscustomobject]@{
    id = "cand_$($StoryKey -replace '[^a-zA-Z0-9]', '')_$($PaletteKey -replace '[^a-zA-Z0-9]', '')_$Ordinal"
    storyKey = $StoryKey
    storyType = $StoryType
    chainIndex = $ChainIndex
    shapeIndex = $ShapeIndex
    start = [int]$ContentRange.Start
    end = [int]$ContentRange.End
    containerStart = [int]$ContainerRange.Start
    containerEnd = [int]$ContainerRange.End
    contentStart = [int]$ContentRange.Start
    contentEnd = [int]$ContentRange.End
    text = $text
    before = $beforeText
    after = $afterText
    container = [pscustomobject]@{ kind = $ContainerKind }
    mark = [pscustomobject]@{ kind = $Kind; rawColor = $RawColor; displayColor = $DisplayColor; paletteKey = $PaletteKey }
    scopeHints = [pscustomobject]@{ exactStart = [int]$ContentRange.Start; exactEnd = [int]$ContentRange.End }
    page = $page
    fingerprint = $fingerprint
    ordinal = $Ordinal
    tableOrdinal = $TableOrdinal
    cellOrdinal = $CellOrdinal
  }
}

# Mechanizm A: Word Highlight (16 indeksowanych kolorow, w:highlight w OOXML).
#
# UWAGA (audyt 2026-09-10, druga runda): pierwotna implementacja uzywala
# Find.Highlight = $true (znajdz DOWOLNY highlight, bez rozroznienia koloru) +
# character-walk do doprecyzowania granicy. Zweryfikowane live, ze to
# NIESTABILNE: po wyczerpaniu PRAWDZIWYCH highlightow w story, kolejne
# wywolania Find.Execute() z tymi samymi kryteriami potrafily zwracac
# $found=$true dla fragmentow, ktore w ogole nie sa highlightowane (w
# zaobserwowanym przypadku: tekst z SAMYM tylko cieniowaniem, bez zadnego
# highlightu, zostal blednie zgloszony jako "highlight:yellow"). To nie byla
# tylko petla bez postepu (naprawiona osobno straznikiem minAllowedStart) -
# to byly GENUINE FALSZYWE DOPASOWANIA tresci. Zamiast probowac dalej
# naprawiac Find dla tego przypadku, mechanizm A uzywa TEGO SAMEGO, juz
# sprawdzonego recznego "character walk" (Get-ScyzorykCharWalkRanges), co
# skaner TextFrame/textbox (mechanizm E) - wolniejszy niz Find dla duzych
# dokumentow, ale deterministyczny i nie podatny na te falszywe dopasowania.
function Find-ScyzorykHighlightCandidates($storyInstance, [string[]]$selectedHighlightKeys, [ref]$counterByKey, [ref]$diagCounts, [ref]$mechanismErrors) {
  $candidates = New-Object System.Collections.Generic.List[object]
  if (-not $selectedHighlightKeys -or $selectedHighlightKeys.Count -eq 0) { return $candidates }
  $selectedSet = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($k in $selectedHighlightKeys) { [void]$selectedSet.Add($k) }

  $story = $storyInstance.Range
  try {
    $hits = Get-ScyzorykCharWalkRanges $story {
      param($r) try { [int]$r.HighlightColorIndex } catch { 0 }
    } {
      param($v) $v -ne 0
    }
    foreach ($hit in $hits) {
      $hlKey = $script:ScyzorykHighlightIndexToKey[[int]$hit.Value]
      if (-not $hlKey -or -not $selectedSet.Contains($hlKey)) { continue }

      # Znak konca akapitu (Chr 13) potrafi odziedziczyc highlight
      # sasiadujacego tekstu - jesli trafil do dopasowania, wycinamy go z
      # ContentRange (zeby pozniejsza podmiana na MERGEFIELD/staly tekst nie
      # skasowala podzialu akapitow), ale zostawiamy w ContainerRange.
      $containerRange = $hit.Range
      $contentRange = $hit.Range.Duplicate
      $rawText = [string]$hit.Range.Text
      if ($rawText.Length -gt 0 -and $rawText.EndsWith([string][char]13)) {
        $contentRange.End = $containerRange.End - 1
      }
      if ($contentRange.Start -ge $contentRange.End) { continue } # sam znak konca akapitu, brak realnej tresci

      $paletteKey = "highlight:$hlKey"
      $counterByKey.Value[$paletteKey] = ([int]($counterByKey.Value[$paletteKey])) + 1
      $candidates.Add((New-ScyzorykCandidate -ContainerRange $containerRange -ContentRange $contentRange -StoryKey $storyInstance.StoryKey -StoryType $storyInstance.StoryType -ChainIndex $storyInstance.ChainIndex -ShapeIndex $null -Kind 'highlight' -ContainerKind $null -RawColor $hlKey -DisplayColor $script:ScyzorykHighlightMap[$hlKey].hex -PaletteKey $paletteKey -Ordinal $counterByKey.Value[$paletteKey])) | Out-Null
      $diagCounts.Value.highlightRangesFound++
    }
  } catch {
    $mechanismErrors.Value.Add([pscustomobject]@{ mechanism = 'highlight'; storyKey = $storyInstance.StoryKey; message = $_.Exception.Message }) | Out-Null
  }
  return $candidates
}

# Mechanizm B: run/font-level shading (w:shd wewnatrz w:rPr). WLASCIWA
# wlasciwosc to Find.Font.Shading (NIE Find.Shading, ktora nie istnieje na
# obiekcie Find - patrz komentarz audytu). Petla PER wybrany kolor, bo Find
# nie ma odpowiednika "dowolne shading" jak przy highlight.
function Find-ScyzorykRunShadingCandidates($storyInstance, [string[]]$shadingHexes, [ref]$counterByKey, [ref]$diagCounts, [ref]$mechanismErrors) {
  $candidates = New-Object System.Collections.Generic.List[object]
  if (-not $shadingHexes -or $shadingHexes.Count -eq 0) { return $candidates }
  $story = $storyInstance.Range

  foreach ($hex in $shadingHexes) {
    $paletteKey = "shading:$hex"
    $oleColor = ConvertTo-ScyzorykOleColor $hex
    $guard = 0
    # Patrz komentarz przy Find-ScyzorykHighlightCandidates (audyt 2026-09-10) -
    # ten sam zabezpieczajacy wzorzec (swiezy Duplicate co iteracje +
    # minAllowedStart) przeciwko potwierdzonemu live "duchowi" ostatniego
    # dopasowania Word COM Find po wyczerpaniu prawdziwych wynikow.
    $minAllowedStart = $story.Start
    try {
      while ($guard -lt 20000) {
        $guard++
        $search = $story.Duplicate
        $search.Start = $minAllowedStart
        $search.End = $story.End
        if ($search.Start -ge $search.End) { break }

        $f = $search.Find
        $f.ClearFormatting()
        $f.Text = ""
        $f.Font.Shading.BackgroundPatternColor = $oleColor
        $f.Forward = $true
        $f.Wrap = 0
        $f.Format = $true
        $found = $f.Execute()
        if (-not $found) { break }
        if ($search.Start -lt $minAllowedStart) { break }
        if ([string]::IsNullOrEmpty([string]$search.Text)) { $minAllowedStart = $search.End; continue }

        $counterByKey.Value[$paletteKey] = ([int]($counterByKey.Value[$paletteKey])) + 1
        $candRange = $search.Duplicate
        $candidates.Add((New-ScyzorykCandidate -ContainerRange $candRange -ContentRange $candRange -StoryKey $storyInstance.StoryKey -StoryType $storyInstance.StoryType -ChainIndex $storyInstance.ChainIndex -ShapeIndex $null -Kind 'shading-run' -ContainerKind $null -RawColor $hex -DisplayColor "#$hex" -PaletteKey $paletteKey -Ordinal $counterByKey.Value[$paletteKey])) | Out-Null
        $diagCounts.Value.runShadingRangesFound++

        $minAllowedStart = $candRange.End
      }
    } catch {
      $mechanismErrors.Value.Add([pscustomobject]@{ mechanism = 'shading-run'; storyKey = $storyInstance.StoryKey; message = $_.Exception.Message }) | Out-Null
    }
  }
  return $candidates
}

# Mechanizm C: paragraph shading (w:shd wewnatrz w:pPr) - Find.ParagraphFormat.Shading,
# CALKOWICIE OSOBNY mechanizm od run shading. Dopasowany Range OBEJMUJE
# koncowy znak akapitu (potwierdzone live: text konczy sie na "\r"), wiec
# ContentRange (to, co pozniej stanie sie polem/stalym tekstem) musi byc o
# JEDEN znak krotszy niz ContainerRange (ktory sluzy do czyszczenia
# formatowania i - dla blokow - do bookmarka obejmujacego caly akapit).
function Find-ScyzorykParagraphShadingCandidates($storyInstance, [string[]]$shadingHexes, [ref]$counterByKey, [ref]$diagCounts, [ref]$mechanismErrors) {
  $candidates = New-Object System.Collections.Generic.List[object]
  if (-not $shadingHexes -or $shadingHexes.Count -eq 0) { return $candidates }
  $story = $storyInstance.Range

  foreach ($hex in $shadingHexes) {
    $paletteKey = "shading:$hex"
    $oleColor = ConvertTo-ScyzorykOleColor $hex
    $guard = 0
    # Patrz komentarz przy Find-ScyzorykHighlightCandidates (audyt 2026-09-10).
    $minAllowedStart = $story.Start
    try {
      while ($guard -lt 20000) {
        $guard++
        $search = $story.Duplicate
        $search.Start = $minAllowedStart
        $search.End = $story.End
        if ($search.Start -ge $search.End) { break }

        $f = $search.Find
        $f.ClearFormatting()
        $f.Text = ""
        $f.ParagraphFormat.Shading.BackgroundPatternColor = $oleColor
        $f.Forward = $true
        $f.Wrap = 0
        $f.Format = $true
        $found = $f.Execute()
        if (-not $found) { break }
        if ($search.Start -lt $minAllowedStart) { break }
        if ([string]::IsNullOrEmpty([string]$search.Text)) { $minAllowedStart = $search.End; continue }

        $counterByKey.Value[$paletteKey] = ([int]($counterByKey.Value[$paletteKey])) + 1
        $containerRange = $search.Duplicate
        $contentRange = $search.Duplicate
        $rawText = [string]$search.Text
        if ($rawText.EndsWith([string][char]13)) {
          $contentRange.End = $containerRange.End - 1
        }
        $candidates.Add((New-ScyzorykCandidate -ContainerRange $containerRange -ContentRange $contentRange -StoryKey $storyInstance.StoryKey -StoryType $storyInstance.StoryType -ChainIndex $storyInstance.ChainIndex -ShapeIndex $null -Kind 'shading-paragraph' -ContainerKind 'paragraph' -RawColor $hex -DisplayColor "#$hex" -PaletteKey $paletteKey -Ordinal $counterByKey.Value[$paletteKey])) | Out-Null
        $diagCounts.Value.paragraphShadingRangesFound++

        $minAllowedStart = $containerRange.End
      }
    } catch {
      $mechanismErrors.Value.Add([pscustomobject]@{ mechanism = 'shading-paragraph'; storyKey = $storyInstance.StoryKey; message = $_.Exception.Message }) | Out-Null
    }
  }
  return $candidates
}

# Mechanizm D: table-cell shading (w:shd wewnatrz w:tcPr) - Word Find NIE MA
# zadnego odpowiednika dla "cieniowanie calej komorki", wiec iterujemy
# bezposrednio. Table.Range.Cells (NIE Rows/Rows.Cells - repo ma juz
# udokumentowany problem ze scalonymi komorkami pionowo, patrz komentarz przy
# tej funkcji w oryginalnym audycie) - zweryfikowane live: po scaleniu 2
# komorek 3x2 tabeli, Range.Cells poprawnie zwraca 5 elementow (nie 6).
# ContentRange = cala zawartosc komorki BEZ koncowego markera end-of-cell
# (Chr(7)) i BEZ poprzedzajacego go znaku konca akapitu (Chr(13)) - inaczej
# pozniejsza podmiana na MERGEFIELD/staly tekst uszkodzilaby strukture tabeli
# (patrz komentarz audytu na gorze pliku i sekcja 5.D specyfikacji).
function Find-ScyzorykCellShadingCandidates($storyInstance, [string[]]$shadingHexes, [ref]$counterByKey, [ref]$diagCounts, [ref]$mechanismErrors) {
  $candidates = New-Object System.Collections.Generic.List[object]
  if (-not $shadingHexes -or $shadingHexes.Count -eq 0) { return $candidates }
  $story = $storyInstance.Range
  $selectedSet = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($h in $shadingHexes) { [void]$selectedSet.Add($h.ToUpperInvariant()) }

  try {
    $tableOrdinal = 0
    foreach ($table in $story.Tables) {
      $tableOrdinal++
      $cellOrdinal = 0
      foreach ($cell in $table.Range.Cells) {
        $cellOrdinal++
        $color = -16777216
        try { $color = [long]$cell.Shading.BackgroundPatternColor } catch {}
        if ($color -lt 0) { continue }
        $hex = ConvertTo-ScyzorykRgbHex $color
        if (-not $hex -or -not $selectedSet.Contains($hex)) { continue }
        $paletteKey = "shading:$hex"

        $containerRange = $cell.Range.Duplicate
        $contentRange = $cell.Range.Duplicate
        # Kazda komorka konczy sie Chr(7) (end-of-cell marker), zwykle
        # poprzedzonym Chr(13) (koniec ostatniego akapitu w komorce) - oba sa
        # czescia KONTENERA (czyszczenie shadingu/bookmark), ale NIGDY nie
        # moga byc czescia tresci wstawianego pola. UWAGA (zweryfikowane live,
        # audyt 2026-09-10): tych dwoch znakow NIE da sie odjac przez proste
        # odejmowanie dlugosci od .End - w adresowaniu pozycji Word ostatni
        # znak akapitu bezposrednio przed markerem konca komorki zajmuje
        # WSPOLNIE z nim TYLKO JEDNA pozycje (mimo ze .Text zwraca dla nich 2
        # znaki), wiec zmniejszamy .End krok po kroku o 1 i za kazdym razem
        # PONOWNIE odczytujemy .Text, zamiast z gory wyliczac dlugosc do
        # obciecia - to dziala niezaleznie od dokladnego mechanizmu tego
        # zlaczenia pozycji.
        $guardTrim = 0
        while ($contentRange.End -gt $contentRange.Start -and $guardTrim -lt 10) {
          $guardTrim++
          $probeText = [string]$contentRange.Text
          if ($probeText.Length -eq 0) { break }
          $lastCode = [int][char]$probeText[$probeText.Length - 1]
          if ($lastCode -eq 13 -or $lastCode -eq 7) {
            $contentRange.End = $contentRange.End - 1
          } else {
            break
          }
        }

        $counterByKey.Value[$paletteKey] = ([int]($counterByKey.Value[$paletteKey])) + 1
        $candidates.Add((New-ScyzorykCandidate -ContainerRange $containerRange -ContentRange $contentRange -StoryKey $storyInstance.StoryKey -StoryType $storyInstance.StoryType -ChainIndex $storyInstance.ChainIndex -ShapeIndex $null -Kind 'shading-cell' -ContainerKind 'tableCell' -RawColor $hex -DisplayColor "#$hex" -PaletteKey $paletteKey -Ordinal $counterByKey.Value[$paletteKey] -TableOrdinal $tableOrdinal -CellOrdinal $cellOrdinal)) | Out-Null
        $diagCounts.Value.cellShadingRangesFound++
      }
    }
  } catch {
    $mechanismErrors.Value.Add([pscustomobject]@{ mechanism = 'shading-cell'; storyKey = $storyInstance.StoryKey; message = $_.Exception.Message }) | Out-Null
  }
  return $candidates
}

# Mechanizm E: tekst wewnatrz ksztaltow (TextFrame/textbox, story=5). Find NIE
# DZIALA tutaj wcale (zweryfikowane live - patrz komentarz audytu), wiec
# skanujemy WYLACZNIE recznym character-walkiem, oddzielnie dla highlight i
# dla shading. Kazdy shape ma WLASNA, od-zera numeracje Start/End (kolejny
# powod, dla ktorego identyfikujemy kandydata przez shapeIndex, nie
# storyType/chainIndex - patrz Get-ScyzorykUniqueStoryKey).
function Find-ScyzorykTextFrameCandidates($doc, [string[]]$selectedHighlightKeys, [string[]]$shadingHexes, [ref]$counterByKey, [ref]$diagCounts, [ref]$mechanismErrors) {
  $candidates = New-Object System.Collections.Generic.List[object]
  $selectedHlSet = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($k in ($selectedHighlightKeys | Where-Object { $_ })) { [void]$selectedHlSet.Add($k) }
  $selectedShadingSet = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($h in ($shadingHexes | Where-Object { $_ })) { [void]$selectedShadingSet.Add($h.ToUpperInvariant()) }
  if ($selectedHlSet.Count -eq 0 -and $selectedShadingSet.Count -eq 0) { return $candidates }

  try {
    $shapeIndex = 0
    foreach ($shape in $doc.Shapes) {
      $shapeIndex++
      $hasText = $false
      try { $hasText = [bool]$shape.TextFrame.HasText } catch { continue }
      if (-not $hasText) { continue }
      $textRange = $shape.TextFrame.TextRange
      $storyKey = Get-ScyzorykUniqueStoryKey 'textframe' 0 $shapeIndex

      if ($selectedHlSet.Count -gt 0) {
        $hlRanges = Get-ScyzorykCharWalkRanges $textRange {
          param($r) try { [int]$r.HighlightColorIndex } catch { 0 }
        } {
          param($v) $v -ne 0
        }
        foreach ($hit in $hlRanges) {
          $hlKey = $script:ScyzorykHighlightIndexToKey[[int]$hit.Value]
          if (-not $hlKey -or -not $selectedHlSet.Contains($hlKey)) { continue }
          # Znak konca akapitu potrafi odziedziczyc highlight (jak w mechanizmie
          # A) - wycinamy go z ContentRange, zeby wstawienie MERGEFIELD/stalego
          # tekstu nie skasowalo podzialu akapitow w wieloakapitowym textboxie.
          $containerRange = $hit.Range
          $contentRange = $hit.Range.Duplicate
          $rawHitText = [string]$hit.Range.Text
          if ($rawHitText.Length -gt 0 -and $rawHitText.EndsWith([string][char]13)) {
            $contentRange.End = $containerRange.End - 1
          }
          if ($contentRange.Start -ge $contentRange.End) { continue }
          $paletteKey = "highlight:$hlKey"
          $counterByKey.Value[$paletteKey] = ([int]($counterByKey.Value[$paletteKey])) + 1
          $candidates.Add((New-ScyzorykCandidate -ContainerRange $containerRange -ContentRange $contentRange -StoryKey $storyKey -StoryType 5 -ChainIndex 0 -ShapeIndex $shapeIndex -Kind 'highlight' -ContainerKind 'textframe' -RawColor $hlKey -DisplayColor $script:ScyzorykHighlightMap[$hlKey].hex -PaletteKey $paletteKey -Ordinal $counterByKey.Value[$paletteKey])) | Out-Null
          $diagCounts.Value.textframeRangesFound++
        }
      }

      if ($selectedShadingSet.Count -gt 0) {
        $shRanges = Get-ScyzorykCharWalkRanges $textRange {
          param($r) try { [long]$r.Shading.BackgroundPatternColor } catch { -16777216 }
        } {
          param($v) $v -ge 0
        }
        foreach ($hit in $shRanges) {
          $hex = ConvertTo-ScyzorykRgbHex ([long]$hit.Value)
          if (-not $hex -or -not $selectedShadingSet.Contains($hex)) { continue }
          $paletteKey = "shading:$hex"
          $counterByKey.Value[$paletteKey] = ([int]($counterByKey.Value[$paletteKey])) + 1
          $candidates.Add((New-ScyzorykCandidate -ContainerRange $hit.Range -ContentRange $hit.Range -StoryKey $storyKey -StoryType 5 -ChainIndex 0 -ShapeIndex $shapeIndex -Kind 'shading-run' -ContainerKind 'textframe' -RawColor $hex -DisplayColor "#$hex" -PaletteKey $paletteKey -Ordinal $counterByKey.Value[$paletteKey])) | Out-Null
          $diagCounts.Value.textframeRangesFound++
        }
      }
    }
  } catch {
    $mechanismErrors.Value.Add([pscustomobject]@{ mechanism = 'textframe'; storyKey = 'textframe'; message = $_.Exception.Message }) | Out-Null
  }
  return $candidates
}

# ETAP 1 specyfikacji Kreatora: znajduje wszystkie kandydujace zakresy dla
# WYBRANYCH przez uzytkownika kolorow/rodzajow oznaczen ("selectedMarkings" =
# lista kluczy typu "highlight:yellow" / "shading:FFE599", dokladnie takich
# jak zwrocone przez Get-ScyzorykMarkingPalette). Uzywana WPROST identycznie
# przez scan-template.ps1 (pierwszy skan) i build-template.ps1 (ponowna
# weryfikacja PRZED mutacja - sekcja 22: "upewnij sie, ze pracujesz na tej
# samej kopii DOCX... nie zgaduj pozycji po samym tekscie") - to jedno,
# wspolne miejsce gwarantuje, ze oba kroki widza DOKLADNIE te same kandydatury
# w tej samej kolejnosci (przy niezmienionym pliku), wiec dopasowanie po
# (storyKey, paletteKey, ordinal) miedzy skanem a buildem jest jednoznaczne -
# fingerprint (patrz New-ScyzorykCandidate) jest DODATKOWA, niezalezna od
# pozycji weryfikacja tresci.
#
# Zwraca [pscustomobject]@{ Candidates = [...]; Diagnostics = [...] } -
# diagnostyka (sekcja 7 audytu naprawczego) pozwala scan-template.ps1
# zaraportowac np. "przeskanowano 5 stories, 0 trafien highlight" zamiast
# tylko surowego "0 kandydatow", oraz przekazac ewentualne bledy pojedynczych
# mechanizmow (mechanismErrors) BEZ zamieniania ich w cichy brak wynikow.
function Find-ScyzorykMarkedCandidates($doc, [string[]]$selectedMarkings) {
  $result = [pscustomobject]@{
    Candidates = New-Object System.Collections.Generic.List[object]
    Diagnostics = [pscustomobject]@{
      storiesScanned = 0
      highlightRangesFound = 0
      runShadingRangesFound = 0
      paragraphShadingRangesFound = 0
      cellShadingRangesFound = 0
      textframeRangesFound = 0
      selectedMarkings = @($selectedMarkings)
      mechanismErrors = New-Object System.Collections.Generic.List[object]
    }
  }
  if ($null -eq $doc -or -not $selectedMarkings -or $selectedMarkings.Count -eq 0) { return $result }

  $highlightKeys = @($selectedMarkings | Where-Object { $_ -like 'highlight:*' } | ForEach-Object { $_.Substring(10) })
  $shadingHexes = @($selectedMarkings | Where-Object { $_ -like 'shading:*' } | ForEach-Object { $_.Substring(8).ToUpperInvariant() })

  $counterByKey = @{}
  $diagCountsRef = [ref]$result.Diagnostics
  $mechanismErrorsRef = [ref]$result.Diagnostics.mechanismErrors

  $instances = Get-ScyzorykStoryInstances $doc
  foreach ($storyInstance in $instances) {
    $result.Diagnostics.storiesScanned++
    (Find-ScyzorykHighlightCandidates $storyInstance $highlightKeys ([ref]$counterByKey) $diagCountsRef $mechanismErrorsRef) | ForEach-Object { $result.Candidates.Add($_) }
    (Find-ScyzorykRunShadingCandidates $storyInstance $shadingHexes ([ref]$counterByKey) $diagCountsRef $mechanismErrorsRef) | ForEach-Object { $result.Candidates.Add($_) }
    (Find-ScyzorykParagraphShadingCandidates $storyInstance $shadingHexes ([ref]$counterByKey) $diagCountsRef $mechanismErrorsRef) | ForEach-Object { $result.Candidates.Add($_) }
    (Find-ScyzorykCellShadingCandidates $storyInstance $shadingHexes ([ref]$counterByKey) $diagCountsRef $mechanismErrorsRef) | ForEach-Object { $result.Candidates.Add($_) }
  }
  (Find-ScyzorykTextFrameCandidates $doc $highlightKeys $shadingHexes ([ref]$counterByKey) $diagCountsRef $mechanismErrorsRef) | ForEach-Object { $result.Candidates.Add($_) }

  # Deduplikacja (sekcja 6 audytu naprawczego): ten sam fizyczny fragment nie
  # powinien powstac dwukrotnie z DOKLADNIE tych samych wspolrzednych i tego
  # samego paletteKey/kind (mechanizmy operuja na rozlacznych warstwach OOXML,
  # wiec w praktyce to tylko siatka bezpieczenstwa, nie oczekiwana sciezka).
  $seen = New-Object 'System.Collections.Generic.HashSet[string]'
  $deduped = New-Object System.Collections.Generic.List[object]
  foreach ($c in $result.Candidates) {
    $key = "$($c.storyKey)|$($c.contentStart)|$($c.contentEnd)|$($c.mark.paletteKey)|$($c.mark.kind)"
    if ($seen.Add($key)) { $deduped.Add($c) | Out-Null }
  }
  $result.Candidates = $deduped

  return $result
}

function Apply-ScyzorykSmartBlocks($doc, $record) {
  # Zwraca liste ostrzezen/bledow (pscustomobject { level, message }) -
  # CELOWO nie rzuca wyjatku dla pojedynczego brakujacego/uszkodzonego bloku,
  # zeby jeden zly bookmark nie przerywal calego rekordu w polowie generowania
  # calej paczki. Wywolujacy (petla per-record w mailmerge-to-pdf.ps1) decyduje,
  # co zrobic z wynikiem (np. dopisac do logu/debug-events.jsonl).
  #
  # REAL BUG (zlapany na zywym dokumencie klienta 2026-09-24, po naprawie
  # niezaleznego bledu wykrywania Smart Template w server.js, ktory dotad
  # maskowal ten): KAZDY `return $result` w tej funkcji byl bledny, nie tylko
  # ten z komentarza przy Range.Delete() nizej. PowerShell "rozpakowuje"
  # zwracana kolekcje IEnumerable na wyjsciu z funkcji - PUSTA
  # Generic.List[object] (najczestszy przypadek: manifest bez zadnych blokow,
  # `blocks: []`) staje sie u WYWOLUJACEGO gola wartoscia $null, a lista z
  # DOKLADNIE JEDNYM elementem (np. pojedynczy blad odczytu _scyBlocksJson)
  # zamienia sie w goly pojedynczy element (nie liste). W obu przypadkach
  # `$smartBlockIssues.Count` w mailmerge-to-pdf.ps1 rzuca pod StrictMode
  # "The property 'Count' cannot be found on this object" - i to dla KAZDEGO
  # rekordu, bo `blocks: []` jest normalnym, czestym przypadkiem (wzor bez
  # zadnego warunku). Zweryfikowane empirycznie (PowerShell 5.1: pusta lista
  # zwrocona przez `return $lista` u wywolujacego to $null; z jednym
  # elementem to goly element, NIE lista). Naprawa: jednoelementowy operator
  # przecinka (`return ,$result`) wymusza zachowanie typu kolekcji niezaleznie
  # od liczby elementow (0, 1 czy wiecej) - zastosowane przy KAZDYM return
  # w tej funkcji, nie tylko przy tym z historycznego komentarza.
  $result = New-Object System.Collections.Generic.List[object]
  if ($null -eq $doc -or $null -eq $record) { return ,$result }

  $blocksProp = $record.PSObject.Properties['_scyBlocksJson']
  if ($null -eq $blocksProp -or [string]::IsNullOrWhiteSpace([string]$blocksProp.Value)) { return ,$result }

  $blocksState = $null
  try {
    $blocksState = [string]$blocksProp.Value | ConvertFrom-Json
  } catch {
    $result.Add([pscustomobject]@{ level = 'error'; message = "Nie udalo sie odczytac _scyBlocksJson: $($_.Exception.Message)" }) | Out-Null
    return ,$result
  }
  if ($null -eq $blocksState) { return ,$result }

  # KROK 1: zbierz WSZYSTKIE potrzebne zakresy PRZED jakakolwiek mutacja
  # dokumentu. Usuwanie tresci/bookmarka przesuwa pozycje (Start/End) kazdego
  # NASTEPNEGO bookmarka w dokumencie - gdybysmy czytali Range.Start w locie,
  # w trakcie przetwarzania, kazda kolejna operacja pracowalaby na juz
  # nieaktualnych wspolrzednych.
  $entries = New-Object System.Collections.Generic.List[object]
  foreach ($prop in $blocksState.PSObject.Properties) {
    $bookmarkName = [string]$prop.Name
    $keep = [bool]$prop.Value
    if (-not $doc.Bookmarks.Exists($bookmarkName)) {
      # Realny, oczekiwany przypadek: uzytkownik recznie edytowal gotowy wzor
      # po zbudowaniu go w Kreatorze i przypadkiem usunal/uszkodzil bookmark -
      # zglaszamy to jawnie zamiast po cichu pomijac caly warunek.
      $result.Add([pscustomobject]@{ level = 'error'; message = "Brak bookmarka '$bookmarkName' wymaganego przez wzor - sprawdz, czy dokument nie zostal recznie zmieniony po zbudowaniu w Kreatorze." }) | Out-Null
      continue
    }
    $bm = $doc.Bookmarks.Item($bookmarkName)
    $entries.Add([pscustomobject]@{ name = $bookmarkName; keep = $keep; start = [int]$bm.Range.Start }) | Out-Null
  }

  # KROK 2: przetwarzaj od KONCA dokumentu do POCZATKU (malejaco po Start) -
  # usuniecie zakresu blizej konca dokumentu NIE zmienia pozycji zadnego
  # zakresu lezacego przed nim, ktory wciaz czeka na przetworzenie. W
  # odwrotnej kolejnosci kazde usuniecie przesuneloby wspolrzedne wszystkich
  # kolejnych (jeszcze nieprzetworzonych) blokow.
  $sorted = $entries | Sort-Object -Property start -Descending
  foreach ($entry in $sorted) {
    try {
      if (-not $doc.Bookmarks.Exists($entry.name)) { continue }
      $bm = $doc.Bookmarks.Item($entry.name)
      if ($entry.keep) {
        # true -> warunek spelniony, TRESC zostaje - usuwamy WYLACZNIE sam
        # znacznik bookmarka (Bookmark.Delete() w Word COM kasuje tylko
        # nazwana referencje, nigdy tekst pod nia), zeby w gotowym dokumencie
        # nie zostal zaden widoczny slad mechanizmu Kreatora.
        [void]$bm.Delete()
      } else {
        # false -> warunek niespelniony, caly zakres (wraz z trescia -
        # akapitami, listami, tabelami, formatowaniem) znika z dokumentu.
        # [void] jest tu KONIECZNY: Range.Delete() w Word COM (w
        # odroznieniu od Bookmark.Delete()) zwraca liczbe usunietych
        # jednostek (Long). Bez tlumienia ta wartosc wyciekala na potok
        # wyjsciowy funkcji i - gdy akurat byl to JEDYNY obiekt w strumieniu
        # (pusta $result, dokladnie jeden blok do usuniecia) - PowerShell
        # zwracal do wywolujacego goly Int32 zamiast listy $result. Pod
        # Set-StrictMode w mailmerge-to-pdf.ps1 kolejne odwolanie
        # $smartBlockIssues.Count rzucalo wtedy "The property 'Count'
        # cannot be found on this object" (real bug, zlapany na zywo
        # 2026-09-14 przy pierwszym pelnym tescie preview po migracji na
        # Open XML - poprzednie testy migracji sprawdzaly tylko skan/build,
        # nigdy pelnego cyklu preview z warunkiem blokowym false).
        $range = $bm.Range
        [void]$range.Delete()
      }
    } catch {
      $result.Add([pscustomobject]@{ level = 'error'; message = "Nie udalo sie przetworzyc bloku '$($entry.name)': $($_.Exception.Message)" }) | Out-Null
    }
  }

  return ,$result
}
