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

# Mapowanie nazw kolorow Word Highlight (OOXML ST_HighlightColor, jak w
# w:highlight w:val="..." w samym pliku .docx) na numeryczny WdColorIndex
# (jedyny sposob, w jaki COM Find.Font.HighlightColorIndex pozwala wybrac
# KONKRETNY kolor highlight do wyszukania) oraz na przyblizony kolor HEX do
# wyswietlenia w UI. To jest udokumentowane, jeden-do-jednego odwzorowanie
# uzywane przez sam Word przy zapisie/odczycie pliku (np. OOXML "green" to
# faktycznie WdColorIndex.wdBrightGreen=4, a "darkGreen" to wdGreen=11 -
# WdColorIndex nie ma osobnej "ciemnej zieleni", tylko jeden Green).
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
# "darkGreen" dla WdColorIndex.wdGreen, "green" dla wdBrightGreen, itd. -
# patrz komentarz wyzej).
$script:ScyzorykOoxmlHighlightToKey = @{
  black = 'black'; blue = 'blue'; cyan = 'cyan'; darkblue = 'darkblue'
  darkcyan = 'teal'; darkgray = 'gray50'; darkgreen = 'green'
  darkmagenta = 'violet'; darkred = 'darkred'; darkyellow = 'darkyellow'
  green = 'brightgreen'; lightgray = 'gray25'; magenta = 'pink'
  red = 'red'; white = 'white'; yellow = 'yellow'
}

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

# Nazwa Story do wyswietlenia/grupowania nakladania sie zakresow (sekcja 21/34) -
# WdStoryType numeryczne wartosci sa stabilne w calym Word COM API.
function Get-ScyzorykStoryKey([int]$storyType) {
  switch ($storyType) {
    1 { return 'main' }
    6 { return 'footnotes' }
    7 { return 'endnotes' }
    default {
      if ($storyType -ge 8 -and $storyType -le 11) { return 'header' }
      if ($storyType -ge 8 -and $storyType -le 13) { return 'footer' }
      return "story$storyType"
    }
  }
}

# ETAP 1 specyfikacji Kreatora: znajduje wszystkie kandydujace zakresy dla
# WYBRANYCH przez uzytkownika kolorow/rodzajow oznaczen ("selectedMarkings" =
# lista kluczy typu "highlight:yellow" / "shading:FFE599", dokladnie takich
# jak zwrocone przez Get-ScyzorykMarkingPalette). Uzywana WPROST identycznie
# przez scan-template.ps1 (pierwszy skan) i build-template.ps1 (ponowna
# weryfikacja PRZED mutacja - sekcja 22: "upewnij sie, ze pracujesz na tej
# samej kopii DOCX... nie zgaduj pozycji po samym tekscie") - to jedno,
# wspolne miejsce gwarantuje, ze oba kroki widza DOKLADNIE te same kandydatury
# w tej samej kolejnosci, wiec dopasowanie po (storyKey, paletteKey, indeks w
# obrebie tej pary) miedzy skanem a buildem jest jednoznaczne.
#
# Word Find dla dopasowania WYLACZNIE po formacie (bez Find.Text) zwraca
# NAJDLUZSZY ciagly fragment o tym samym formacie - sasiednie znaki tego
# samego koloru scalaja sie w jeden kandydat automatycznie (to jest cel:
# "krotki ciag -> jeden kandydat inline, caly akapit -> kandydat akapitowy"),
# bez dodatkowej logiki grupowania z naszej strony.
function Find-ScyzorykMarkedCandidates($doc, [string[]]$selectedMarkings) {
  $candidates = New-Object System.Collections.Generic.List[object]
  if ($null -eq $doc -or -not $selectedMarkings -or $selectedMarkings.Count -eq 0) { return $candidates }

  $highlightKeys = @($selectedMarkings | Where-Object { $_ -like 'highlight:*' } | ForEach-Object { $_.Substring(10) })
  $shadingHexes = @($selectedMarkings | Where-Object { $_ -like 'shading:*' } | ForEach-Object { $_.Substring(8).ToUpperInvariant() })

  $counterByKey = @{}
  $wdCollapseEnd = 0
  $wdFindStop = 0

  $story = $doc.StoryRanges.Item(1)
  while ($null -ne $story) {
    $storyKey = Get-ScyzorykStoryKey $story.StoryType

    foreach ($hlKey in $highlightKeys) {
      if (-not $script:ScyzorykHighlightMap.ContainsKey($hlKey)) { continue }
      $colorIndex = $script:ScyzorykHighlightMap[$hlKey].index
      $paletteKey = "highlight:$hlKey"
      $searchRange = $story.Duplicate
      $guard = 0
      while ($guard -lt 5000) {
        $guard++
        try {
          $find = $searchRange.Find
          $find.ClearFormatting()
          $find.Text = ""
          $find.Font.HighlightColorIndex = $colorIndex
          $find.Forward = $true
          $find.Wrap = $wdFindStop
          $find.Format = $true
          $found = $find.Execute()
        } catch { break }
        if (-not $found) { break }
        if ([string]::IsNullOrEmpty([string]$searchRange.Text)) { $searchRange.Collapse($wdCollapseEnd); continue }

        $counterByKey[$paletteKey] = ([int]($counterByKey[$paletteKey])) + 1
        $candidates.Add((New-ScyzorykCandidate -Range $searchRange -StoryKey $storyKey -Kind 'highlight' -RawColor $hlKey -DisplayColor $script:ScyzorykHighlightMap[$hlKey].hex -PaletteKey $paletteKey -Ordinal $counterByKey[$paletteKey])) | Out-Null

        $searchRange = $searchRange.Duplicate
        $searchRange.Collapse($wdCollapseEnd)
        $searchRange.End = $story.End
      }
    }

    foreach ($hex in $shadingHexes) {
      $paletteKey = "shading:$hex"
      $searchRange = $story.Duplicate
      $guard = 0
      while ($guard -lt 5000) {
        $guard++
        try {
          $r = [Convert]::ToInt32($hex.Substring(0,2), 16)
          $g = [Convert]::ToInt32($hex.Substring(2,2), 16)
          $b = [Convert]::ToInt32($hex.Substring(4,2), 16)
          $oleColor = $r -bor ($g -shl 8) -bor ($b -shl 16)
          $find = $searchRange.Find
          $find.ClearFormatting()
          $find.Text = ""
          $find.Shading.BackgroundPatternColor = $oleColor
          $find.Forward = $true
          $find.Wrap = $wdFindStop
          $find.Format = $true
          $found = $find.Execute()
        } catch { break }
        if (-not $found) { break }
        if ([string]::IsNullOrEmpty([string]$searchRange.Text)) { $searchRange.Collapse($wdCollapseEnd); continue }

        $counterByKey[$paletteKey] = ([int]($counterByKey[$paletteKey])) + 1
        $candidates.Add((New-ScyzorykCandidate -Range $searchRange -StoryKey $storyKey -Kind 'shading' -RawColor $hex -DisplayColor "#$hex" -PaletteKey $paletteKey -Ordinal $counterByKey[$paletteKey])) | Out-Null

        $searchRange = $searchRange.Duplicate
        $searchRange.Collapse($wdCollapseEnd)
        $searchRange.End = $story.End
      }
    }

    try { $story = $story.NextStoryRange } catch { $story = $null }
  }

  return $candidates
}

function New-ScyzorykCandidate($Range, [string]$StoryKey, [string]$Kind, [string]$RawColor, [string]$DisplayColor, [string]$PaletteKey, [int]$Ordinal) {
  $text = ''
  try { $text = [string]$Range.Text } catch {}
  $beforeText = ''
  $afterText = ''
  try {
    $beforeRange = $Range.Duplicate
    $beforeStart = [Math]::Max(0, $Range.Start - 80)
    $beforeRange.Start = $beforeStart
    $beforeRange.End = $Range.Start
    $beforeText = [string]$beforeRange.Text
  } catch {}
  try {
    $afterRange = $Range.Duplicate
    $storyEnd = $Range.StoryLength - 1
    $afterEnd = [Math]::Min($storyEnd, $Range.End + 80)
    $afterRange.Start = $Range.End
    $afterRange.End = $afterEnd
    $afterText = [string]$afterRange.Text
  } catch {}

  $inTable = $false
  try { $inTable = [bool]$Range.Information(12) } catch {} # wdWithInTable = 12
  $page = 1
  try { $page = [int]$Range.Information(3) } catch {} # wdActiveEndPageNumber = 3

  $fingerprintSource = "$StoryKey|$PaletteKey|$Ordinal|$text"
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hashBytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($fingerprintSource))
  $fingerprint = -join ($hashBytes | ForEach-Object { $_.ToString('x2') })

  return [pscustomobject]@{
    id = "cand_$StoryKey`_$($PaletteKey -replace '[^a-zA-Z0-9]', '')`_$Ordinal"
    storyKey = $StoryKey
    start = [int]$Range.Start
    end = [int]$Range.End
    text = $text
    before = $beforeText
    after = $afterText
    container = [pscustomobject]@{ kind = if ($inTable) { 'tableCell' } else { 'paragraph' } }
    mark = [pscustomobject]@{ kind = $Kind; rawColor = $RawColor; displayColor = $DisplayColor; paletteKey = $PaletteKey }
    scopeHints = [pscustomobject]@{ exactStart = [int]$Range.Start; exactEnd = [int]$Range.End }
    page = $page
    fingerprint = $fingerprint
    ordinal = $Ordinal
  }
}

function Apply-ScyzorykSmartBlocks($doc, $record) {
  # Zwraca liste ostrzezen/bledow (pscustomobject { level, message }) -
  # CELOWO nie rzuca wyjatku dla pojedynczego brakujacego/uszkodzonego bloku,
  # zeby jeden zly bookmark nie przerywal calego rekordu w polowie generowania
  # calej paczki. Wywolujacy (petla per-record w mailmerge-to-pdf.ps1) decyduje,
  # co zrobic z wynikiem (np. dopisac do logu/debug-events.jsonl).
  $result = New-Object System.Collections.Generic.List[object]
  if ($null -eq $doc -or $null -eq $record) { return $result }

  $blocksProp = $record.PSObject.Properties['_scyBlocksJson']
  if ($null -eq $blocksProp -or [string]::IsNullOrWhiteSpace([string]$blocksProp.Value)) { return $result }

  $blocksState = $null
  try {
    $blocksState = [string]$blocksProp.Value | ConvertFrom-Json
  } catch {
    $result.Add([pscustomobject]@{ level = 'error'; message = "Nie udalo sie odczytac _scyBlocksJson: $($_.Exception.Message)" }) | Out-Null
    return $result
  }
  if ($null -eq $blocksState) { return $result }

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
        $bm.Delete()
      } else {
        # false -> warunek niespelniony, caly zakres (wraz z trescia -
        # akapitami, listami, tabelami, formatowaniem) znika z dokumentu.
        $range = $bm.Range
        $range.Delete()
      }
    } catch {
      $result.Add([pscustomobject]@{ level = 'error'; message = "Nie udalo sie przetworzyc bloku '$($entry.name)': $($_.Exception.Message)" }) | Out-Null
    }
  }

  return $result
}
