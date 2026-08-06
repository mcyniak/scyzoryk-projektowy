; Instalator Scyzoryka Projektowego (Inno Setup).
;
; Nie jest kompilowany recznie z zawartoscia repo - oczekuje, ze scripts\build-installer.ps1
; przygotowal wczesniej katalog StagingDir zawierajacy:
;   - czysty eksport repo (git archive HEAD, ten sam zestaw plikow co scripts\build-package.js
;     produkuje dla ZIP-a, patrz .gitattributes/.gitignore - bez node_modules/danych/.claude/.serena),
;   - Scyzoryk.exe - natywny launcher (C#/.NET 8, launcher\Scyzoryk.Launcher w repo, zbudowany
;     przez scripts\build-launcher.ps1) - JEDYNY sposob normalnego startu aplikacji (skrot,
;     autostart, restart po aktualizacji, zatrzymanie przy odinstalowaniu) - bez CMD/PowerShell/VBS,
;   - node-runtime\ - bundlowany, portable Node.js (Windows x64), zeby uzytkownik koncowy
;     NIE musial miec Node.js zainstalowanego globalnie na komputerze,
;   - apps\*\node_modules\ - zaleznosci KAZDEJ aplikacji juz zainstalowane (npm install + Chromium
;     dla Playwrighta) - build-installer.ps1 robi to RAZ, przed pakowaniem, nie uzytkownik koncowy,
;   - runtime-fingerprint.txt (scripts\generate-runtime-fingerprint.js) - odcisk "ktory dokladnie
;     runtime (wersja Node + wszystkie package-lock.json) jest w tym stagingu".
;
; Audyt 2026-08-06 (blokada pobierania przez Chrome/AV na czesci komputerow) + zastrzezenie
; wlasciciela ("node_modules nie moze byc pobierany przy kazdej aktualizacji", ~1,2 GB): instalator
; wystepuje w DWOCH wariantach, sterowanych parametrem BuildVariant przekazanym do ISCC:
;   - "full"   - wszystko powyzej, w tym node-runtime i node_modules kazdej apki (~600-900 MB).
;                Jedyny wariant zdolny do PIERWSZEJ instalacji (albo pelnej naprawy).
;   - "update" - BEZ node-runtime i BEZ node_modules (~150-160 MB) - zaklada, ze runtime juz
;                istnieje na dysku z wczesniejszej pelnej instalacji. lib/updateService.js
;                wybiera ten wariant, gdy runtime-fingerprint.txt zainstalowany lokalnie zgadza
;                sie z tym opublikowanym w nowym wydaniu (czyli Node/zaleznosci npm sie NIE
;                zmienily - typowa poprawka bledu w kodzie jednej z 9 aplikacji).
; Oba warianty NIE uruchamiaja juz "npm install"/Playwright na komputerze uzytkownika w ogole -
; to byl dawny krok instaluj-zaleznosci.cmd (usuniety), ukryty CMD pobierajacy pakiety podczas
; instalacji - jedno z podejrzen audytu AV (Podejrzenie B), domkniete przez to samo posuniecie,
; ktore rozwiazuje problem rozmiaru aktualizacji.
;
; Wywolanie: iscc scyzoryk.iss /DStagingDir="C:\sciezka\do\staging" /DAppVersion="1.2.3"
;   /DOutputDir="C:\sciezka\do\release" /DBuildVariant="full"

#ifndef StagingDir
  #define StagingDir "..\release\_staging"
#endif
#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif
#ifndef OutputDir
  #define OutputDir "..\release"
#endif
#ifndef BuildVariant
  #define BuildVariant "full"
#endif
#if (BuildVariant != "full") && (BuildVariant != "update")
  #error BuildVariant musi byc "full" albo "update"
#endif

#define MyAppName "Scyzoryk Projektowy"
#define MyAppPublisher "Dzial Projektowy Sanitarny"

[Setup]
AppId={{B6C1B6D2-6E1E-4B8A-9B0F-3E7C6C9D9A11}
AppName={#MyAppName}
AppVersion={#AppVersion}
AppPublisher={#MyAppPublisher}
; Instalacja per-uzytkownik, bez wymogu uprawnien administratora - to lokalne
; narzedzie biurowe, nie ma powodu wymagac podniesionych uprawnien do instalacji
; (patrz CLAUDE.md: "brak logowania/rol/PIN-ow", to samo podejscie "jak najprosciej").
DefaultDirName={localappdata}\Programs\ScyzorykProjektowy
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DisableWelcomePage=no
OutputDir={#OutputDir}
#if BuildVariant == "full"
OutputBaseFilename=ScyzorykProjektowy-Setup-{#AppVersion}
#else
OutputBaseFilename=ScyzorykProjektowy-Update-{#AppVersion}
#endif
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#MyAppName}
; Node-runtime jest wydany dla Windows x64 - instalator ma sens tylko na x64.
ArchitecturesInstallIn64BitMode=x64compatible
ChangesEnvironment=no

[Languages]
Name: "polish"; MessagesFile: "compiler:Languages\Polish.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
; Check: not IsScyzorykUpdate (patrz [Code] nizej) - podczas cichej aktualizacji
; (/SCYZORYKUPDATE) te zadania sa niedostepne do wyboru, wiec zwiazane z nimi
; kroki [Icons]/[Run] (skrot na pulpicie, ponowna rejestracja autostartu)
; sie NIE wykonuja. Zwykla pierwsza instalacja dziala bez zmian.
Name: "desktopicon"; Description: "Utworz ikone na pulpicie"; GroupDescription: "Dodatkowe ikony:"; Check: not IsScyzorykUpdate
; Zaznaczone domyslnie - to docelowy, zalecany sposob uruchamiania Scyzoryka (patrz
; scyzoryk_final_deployment_plan w pamieci projektu: Zaplanowane zadanie Windows przy
; logowaniu KONKRETNEGO uzytkownika, NIE usluga LocalSystem - zachowuje dostep do
; zmapowanego dysku i domyslnej drukarki przypietych do sesji uzytkownika). Adres
; http://scyzoryk.localhost:3000 (domena .localhost, RFC 6761) dziala bez pliku
; hosts, wiec cala instalacja - w tym to zadanie - pozostaje bez-adminowa.
Name: "autostart"; Description: "Uruchamiaj Scyzoryka automatycznie przy logowaniu (zalecane)"; GroupDescription: "Uruchamianie:"; Check: not IsScyzorykUpdate

[Files]
; Kod aplikacji, launcher, skrypty, runtime-fingerprint.txt - wspolne dla obu
; wariantow. node-runtime i node_modules kazdej apki sa wylaczone stad i
; dolaczane osobno TYLKO w wariancie "full" ponizej (patrz uzasadnienie na
; gorze pliku). Sprawdzone realnie (nie zgadywane): Inno Setup NIE wspiera
; "*" jako dowolnego segmentu w SRODKU wzorca Source (np. "apps\*\node_modules\*"
; nie kompiluje sie - "No files found matching...") - dlatego kazda apka ma
; swoja jawna linie Source nizej zamiast jednego wzorca. Excludes NATOMIAST
; wspiera taki wzorzec poprawnie.
Source: "{#StagingDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion; Excludes: "\node-runtime\*,\apps\*\node_modules\*"

#if BuildVariant == "full"
; Runtime (portable Node + node_modules kazdej aplikacji, w tym Chromium dla
; Playwrighta) - wylacznie w wariancie pelnym. Kazda apka ma wlasna, jawna
; linie (patrz komentarz powyzej - Inno nie wspiera wzorca na cala liste
; aplikacji na raz). Nowa aplikacja pod apps/ wymaga dopisania tu wpisu -
; ten sam duch co rejestrowanie nowej apki w kilku miejscach root server.js
; (patrz CLAUDE.md).
Source: "{#StagingDir}\node-runtime\*"; DestDir: "{app}\node-runtime"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#StagingDir}\apps\dokumenty-seryjne\node_modules\*"; DestDir: "{app}\apps\dokumenty-seryjne\node_modules"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#StagingDir}\apps\drukarka\node_modules\*"; DestDir: "{app}\apps\drukarka\node_modules"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#StagingDir}\apps\drukarka-projekty\node_modules\*"; DestDir: "{app}\apps\drukarka-projekty\node_modules"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#StagingDir}\apps\formularze-ecodan\node_modules\*"; DestDir: "{app}\apps\formularze-ecodan\node_modules"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#StagingDir}\apps\karty-katalogowe\node_modules\*"; DestDir: "{app}\apps\karty-katalogowe\node_modules"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#StagingDir}\apps\nazywarka-skanow\node_modules\*"; DestDir: "{app}\apps\nazywarka-skanow\node_modules"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#StagingDir}\apps\ocr-audytow\node_modules\*"; DestDir: "{app}\apps\ocr-audytow\node_modules"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#StagingDir}\apps\pieczatki-pdf\node_modules\*"; DestDir: "{app}\apps\pieczatki-pdf\node_modules"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#StagingDir}\apps\wnioski-powykonawcze\node_modules\*"; DestDir: "{app}\apps\wnioski-powykonawcze\node_modules"; Flags: recursesubdirs createallsubdirs ignoreversion
#endif

[Icons]
; Filename wskazuje na Scyzoryk.exe (natywny launcher) - bez IconFilename/IconIndex,
; zeby skrot i wpis na pasku zadan uzywaly tej samej, wbudowanej ikony samego EXE.
; Ikona (bialy scyzoryk na czerwonym tle, ten sam motyw co logo w naglowku panelu)
; jest wbudowana w Scyzoryk.exe przez <ApplicationIcon> w
; launcher\Scyzoryk.Launcher.csproj (launcher\Scyzoryk.Launcher\AppIcon.ico) -
; nie trzeba tu dodawac IconFilename, .iss dziedziczy ja automatycznie z EXE.
Name: "{group}\{#MyAppName}"; Filename: "{app}\Scyzoryk.exe"; WorkingDir: "{app}"
Name: "{group}\Odinstaluj {#MyAppName}"; Filename: "{uninstallexe}"
; {userdesktop} (NIE {commondesktop}) - {commondesktop} to pulpit WSPOLNY wszystkich
; kont i wymaga uprawnien administratora do zapisu skrotu (IPersistFile::Save konczyl
; sie "Odmowa dostepu"/0x80070005 pod PrivilegesRequired=lowest - zlapane realnym
; testem instalacji, nie teoretycznie). {userdesktop} to pulpit BIEZACEGO uzytkownika,
; spojny z instalacja per-uzytkownik bez podnoszenia uprawnien.
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\Scyzoryk.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; Audyt 2026-08-06: dawny pierwszy krok tutaj byl "instaluj-zaleznosci.cmd" -
; ukryty CMD uruchamiajacy npm install + pobranie Chromium NA KOMPUTERZE
; UZYTKOWNIKA (Podejrzenie B audytu AV: niepodpisany instalator po cichu
; odpalajacy CMD, ktory pobiera i uruchamia kod pakietow, wyglada jak
; downloader/dropper). Usuniety calkowicie - node_modules kazdej apki (w tym
; Chromium) sa teraz zainstalowane RAZ, w CI, przed zbudowaniem instalatora
; (patrz scripts\build-installer.ps1) i dolaczone bezposrednio do wariantu
; "full" (sekcja [Files] powyzej). Wariant "update" w ogole ich nie potrzebuje -
; zaklada, ze juz sa na dysku z wczesniejszej pelnej instalacji. Instalator
; (oba warianty) nie wymaga juz internetu podczas [Run] w ogole.
; Audyt 2026-08-06 + realny incydent: ten krok kiedys wolal ukrytego
; "powershell.exe -ExecutionPolicy Bypass -File install-autostart.ps1" - ta
; sama sygnatura (interpreter cicho odpalajacy interpreter z ominieciem
; polityki wykonania) byla juz raz zlapana przez firmowy EDR w lancuchu
; aktualizacji (patrz launcher\Scyzoryk.Launcher\LauncherApp.RunApplyUpdateAsync)
; i jest czestym powodem falszywych alarmow "wirus" w Chrome/Windows Defender/AV
; dla niepodpisanych, nowych plikow - potwierdzone realnie: pobranie tego
; instalatora bylo flagowane jako wirus na czesci komputerow. Zamiast
; PowerShella, Scyzoryk.exe --register-autostart rejestruje zadanie natywnie
; przez schtasks.exe (patrz launcher\Scyzoryk.Launcher\AutostartManager.cs) -
; zero PowerShella w tej sciezce. Nie wymaga podniesienia uprawnien. Pomijany
; calkowicie jesli uzytkownik odznaczyl zadanie (Tasks: autostart) - w tym
; rowniez przy /VERYSILENT bez jawnego /MERGETASKS=autostart.
Filename: "{app}\Scyzoryk.exe"; Parameters: "--register-autostart"; WorkingDir: "{app}"; StatusMsg: "Rejestrowanie autostartu przy logowaniu..."; Tasks: autostart; Check: not IsScyzorykUpdate; Flags: runhidden waituntilterminated
; Check: not IsScyzorykUpdate ponizej to dodatkowa (druga) warstwa obok
; skipifsilent - podczas /SCYZORYKUPDATE restart aplikacji robi WYLACZNIE
; Scyzoryk.exe --apply-update (po zakonczeniu instalatora), nigdy ten krok.
; Bez argumentow = tryb normalny Scyzoryk.exe (odpal jesli trzeba, poczekaj na
; zdrowy serwer, otworz przegladarke raz) - patrz launcher\Scyzoryk.Launcher.
Filename: "{app}\Scyzoryk.exe"; Description: "Uruchom Scyzoryka teraz"; Check: not IsScyzorykUpdate; Flags: postinstall skipifsilent nowait

[UninstallRun]
; Wyrejestrowuje zadanie w Harmonogramie, JESLI bylo zarejestrowane (Unregister
; sam sprawdza i nie robi nic jesli nie - patrz AutostartManager.Unregister) -
; bez tego odinstalowanie zostawialoby osierocone zadanie wskazujace na
; usuniety folder. Musi isc PRZED usunieciem plikow (UninstallRun z definicji
; wykonuje sie przed [UninstallDelete]). Bez PowerShella - patrz uzasadnienie
; przy --register-autostart w [Run] powyzej.
Filename: "{app}\Scyzoryk.exe"; Parameters: "--unregister-autostart"; Flags: runhidden; RunOnceId: "UninstallAutostart"
; Zatrzymuje TYLKO node.exe nalezacy do tej instalacji - Scyzoryk.exe --stop
; replikuje dokladnie logike match-po-pelnej-sciezce z dawnego stop-scyzoryk.ps1
; (patrz launcher\Scyzoryk.Launcher\ProcessManager.cs), zeby proces nie blokowal
; plikow podczas usuwania i zeby nie ubijac cudzych node.exe.
Filename: "{app}\Scyzoryk.exe"; Parameters: "--stop"; Flags: runhidden; RunOnceId: "StopScyzoryk"

[Code]
// Rozpoznaje ciche wywolanie ze Scyzoryk.exe --apply-update (patrz
// launcher\Scyzoryk.Launcher\UpdateApplier.cs i lib/updateService.js
// buildUpdaterInvocation): "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-
// /SCYZORYKUPDATE /DIR=...". W tym trybie: bez kreatora (juz zapewnia
// /VERYSILENT), bez ponownej rejestracji autostartu, bez
// ponownego pytania o skrot na pulpicie, bez postinstall-autorun aplikacji -
// restart robi wylacznie Scyzoryk.exe --apply-update PO zakonczeniu tego
// instalatora. Zwykla (pierwsza) instalacja nie przekazuje tego parametru,
// wiec dziala dokladnie tak jak wczesniej.
function IsScyzorykUpdate(): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount do
  begin
    if CompareText(ParamStr(I), '/SCYZORYKUPDATE') = 0 then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

[UninstallDelete]
; Od 2026-08-06 wariant "full" ma node_modules/node-runtime w [Files], wiec
; Inno Setup formalnie "wie" o nich - ALE instalacja typowego uzytkownika
; przechodzi przez oba warianty naprzemiennie w czasie (full -> kilka update ->
; kolejny full po zmianie zaleznosci), a foldery robocze (apps\*\data, uploads,
; output, logs) i tak powstaja dopiero przy pierwszym uzyciu apki, wiec
; nigdy nie sa czescia [Files] zadnego wariantu. Zostawiamy to jako
; bezwarunkowa siatke bezpieczenstwa - usuwa caly folder instalacji, nie
; tylko to, co formalnie zainstalowal ostatnio uruchomiony wariant.
Type: filesandordirs; Name: "{app}"
