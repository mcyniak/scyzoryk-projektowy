# Ghostscript (wendorowany runtime, tylko druk)

Minimalny, przenośny podzbiór oficjalnego Windows x64 buildu Ghostscript/GhostPDL
10.07.1 (Artifex Software), wyekstrahowany z `gs10071w64.exe`
(https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/tag/gs10071,
SHA-512 zweryfikowany przy pobraniu) narzędziem `innoextract`/7-Zip (bez
uruchamiania instalatora - brak uprawnień administratora nie jest tu
potrzebny, ani przy budowaniu, ani u użytkownika końcowego).

Zawiera wyłącznie to, co jest potrzebne do uruchomienia `gswin64c.exe` jako
biblioteki druku (`bin/`, `Resource/`, `lib/`, `iccprofiles/`) - bez `doc/`
(23 MB dokumentacji) i `examples/` (nieużywane w tej apce).

Używany wyłącznie jako zapasowy silnik druku w `lib/printing/print-file.ps1`
(`Invoke-PrintWithGhostscript`, urządzenie `mswinpr2` - druk przez GDI
Windows, nie przez sterownik PDF/PS bezpośrednio) - zastępuje Adobe Acrobat,
którego nie dało się legalnie dołączyć do instalatora.

## Licencja

Ghostscript jest na licencji **AGPL-3.0** (patrz `COPYING` w tym folderze -
pełny, niezmieniony tekst licencji z oficjalnej dystrybucji). Ten katalog
zawiera niezmodyfikowaną binarkę - kod źródłowy Ghostscript jest publicznie
dostępny pod https://github.com/ArtifexSoftware/ghostpdl.
