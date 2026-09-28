# Pobiera konwerter DOCX -> PDF bez Worda: ONLYOFFICE x2t.exe (z oficjalnej
# paczki ONLYOFFICE DocumentBuilder, AGPL v3) do tools\onlyoffice.
# Uzywany przez Scyzoryk.DocumentEngine (Pdf/PdfRenderers.cs) jako osobny,
# niezmodyfikowany program. Kod zrodlowy: https://github.com/ONLYOFFICE/core
#
# Dlaczego ONLYOFFICE (porownanie 2026-09-28 na prawdziwych dokumentach
# powykonawczych, Word jako wzorzec): ta sama liczba stron i wszystkie obrazy;
# LibreOffice gubil zdjecia/skany, Syncfusion jest platny dla firmy tej
# wielkosci, a DocumentBuilder (docbuilder.exe) dopisuje znak wodny - x2t nie.
#
# Uzycie:  powershell -File scripts\fetch-onlyoffice-x2t.ps1 [-Version v9.4.0]

param([string]$Version = 'v9.4.0')

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $PSScriptRoot
$Dest = Join-Path $Root 'tools\onlyoffice'
$Url = "https://github.com/ONLYOFFICE/DocumentBuilder/releases/download/$Version/onlyoffice-documentbuilder-windows-x64.zip"
$Zip = Join-Path ([IO.Path]::GetTempPath()) "onlyoffice-$Version.zip"

Write-Host "Pobieram $Url"
Invoke-WebRequest -UseBasicParsing $Url -OutFile $Zip
if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force }
Expand-Archive $Zip $Dest -Force
Remove-Item $Zip -Force

# Niepotrzebne do konwersji DOCX -> PDF (API dla innych jezykow, naglowki C++).
foreach ($p in @('include', 'docbuilder.jar', 'docbuilder.py', 'docbuilder.jni.dll', 'docbuilder.net.dll', 'docbuilder.com.dll', 'docbuilder.c.dll', 'doctrenderer.lib')) {
  $full = Join-Path $Dest $p
  if (Test-Path $full) { Remove-Item $full -Recurse -Force }
}
# Indeks czcionek budowany jest na komputerze docelowym (inne czcionki) - nie
# pakujemy wersji z maszyny budujacej.
Remove-Item (Join-Path $Dest 'sdkjs\common\AllFonts.js') -Force -ErrorAction SilentlyContinue
Set-Content (Join-Path $Dest 'WERSJA.txt') "ONLYOFFICE DocumentBuilder $Version (AGPL v3), zrodlo: https://github.com/ONLYOFFICE/core" -Encoding UTF8
# Tekst licencji AGPL v3 + informacja o zrodle jada razem z binariami (repo:
# third-party/onlyoffice, patrz tamtejszy README.md).
Copy-Item (Join-Path $Root 'third-party\onlyoffice\LICENSE.txt') (Join-Path $Dest 'LICENSE.txt') -Force
Copy-Item (Join-Path $Root 'third-party\onlyoffice\README.md') (Join-Path $Dest 'README-SCYZORYK.md') -Force

if (-not (Test-Path (Join-Path $Dest 'x2t.exe'))) { throw "Brak x2t.exe po rozpakowaniu $Url" }
$size = [math]::Round(((Get-ChildItem $Dest -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB)
Write-Host "Gotowe: $Dest ($size MB)"
