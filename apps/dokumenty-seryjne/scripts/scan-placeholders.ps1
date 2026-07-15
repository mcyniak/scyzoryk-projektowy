param(
  [Parameter(Mandatory=$true)][string]$TemplatesJson
)

# Skanuje podane pliki .docx w poszukiwaniu tekstu podswietlonego na zolto
# (albo dowolnym innym kolorem highlight) - w praktyce tak wygladaja
# placeholdery w prawdziwych szablonach (np. "Imie i Nazwisko", "XYZ, Kod
# pocztowy", "XXX/X"), ktore NIE sa polami MERGEFIELD ani znacznikami typu
# {{...}} - zwykly tekst z formatowaniem "highlight". Bez tego skryptu
# uzytkownik nie mial jak wiedziec, co dokladnie trzeba podmienic recznymi
# regulami zamiany.
$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-HighlightedTexts([string]$docxPath) {
  $result = New-Object System.Collections.Generic.List[string]
  if (-not (Test-Path -LiteralPath $docxPath)) { return $result }
  $zip = $null
  try {
    $zip = [System.IO.Compression.ZipFile]::OpenRead($docxPath)
    $parts = $zip.Entries | Where-Object { $_.FullName -match '^word/(document|header\d*|footer\d*)\.xml$' }
    foreach ($entry in $parts) {
      $reader = New-Object System.IO.StreamReader($entry.Open())
      $xml = $reader.ReadToEnd()
      $reader.Close()

      $highlights = [regex]::Matches($xml, '<w:highlight\b[^/]*/>')
      foreach ($h in $highlights) {
        $windowStart = $h.Index
        $windowLen = [Math]::Min(500, $xml.Length - $windowStart)
        $window = $xml.Substring($windowStart, $windowLen)
        $tMatch = [regex]::Match($window, '<w:t\b[^>]*>([^<]*)</w:t>')
        if ($tMatch.Success) {
          $text = [System.Net.WebUtility]::HtmlDecode($tMatch.Groups[1].Value).Trim()
          if ($text) { $result.Add($text) }
        }
      }
    }
  } catch {
    # Uszkodzony/niepoprawny docx - po prostu pomijamy ten plik, nie przerywamy calego skanu.
  } finally {
    if ($null -ne $zip) { $zip.Dispose() }
  }
  return $result
}

$paths = @()
try {
  # UWAGA: @( ... | ConvertFrom-Json ) w jednej linii (@() owijajace CALY
  # potok) w Windows PowerShell 5.1 potrafi zwrocic tablice z JEDNYM
  # elementem bedacym zagniezdzona tablica, zamiast splaszczonej listy
  # sciezek - najpierw trzeba przypisac wynik, dopiero potem owinac @().
  $parsedPaths = Get-Content -LiteralPath $TemplatesJson -Raw -Encoding UTF8 | ConvertFrom-Json
  $paths = @($parsedPaths)
} catch {
  Write-Output (@{ ok = $false; message = "Nie udalo sie odczytac listy szablonow." } | ConvertTo-Json -Compress)
  exit 0
}

# Zolte podswietlenie w tych szablonach oznacza DWIE rozne rzeczy:
# 1) krotkie placeholdery per-klient ("Imie i Nazwisko", "XXX/X") - te
#    chcemy pokazac do zmapowania na kolumne Excela;
# 2) dlugie fragmenty/akapity do REGULARNEJ edycji przez projektanta
#    (np. "wybierz wlasciwy opis dachu: skosny / plaski / elewacja") oraz
#    calosc tabeli zestawienia materialowego - tego NIE wolno masowo
#    podmieniac z Excela, wiec odfiltrowujemy po dlugosci.
$MAX_PLACEHOLDER_LENGTH = 60

$seen = New-Object 'System.Collections.Generic.HashSet[string]'
$placeholders = New-Object System.Collections.Generic.List[string]

foreach ($p in $paths) {
  foreach ($text in @(Get-HighlightedTexts ([string]$p))) {
    if ($text.Length -gt $MAX_PLACEHOLDER_LENGTH) { continue }
    $key = $text.ToLowerInvariant()
    if ($seen.Add($key)) { [void]$placeholders.Add($text) }
  }
}

$out = @{ ok = $true; placeholders = @($placeholders) } | ConvertTo-Json -Compress
Write-Output $out
