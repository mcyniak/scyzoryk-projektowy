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
;   - instaluj-zaleznosci.cmd (installer\ w repo) skopiowany do korzenia.
;
; Wywolanie: iscc scyzoryk.iss /DStagingDir="C:\sciezka\do\staging" /DAppVersion="1.2.3" /DOutputDir="C:\sciezka\do\release"

#ifndef StagingDir
  #define StagingDir "..\release\_staging"
#endif
#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif
#ifndef OutputDir
  #define OutputDir "..\release"
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
OutputBaseFilename=ScyzorykProjektowy-Setup-{#AppVersion}
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
; kroki [Icons]/[Run] (skrot na pulpicie, ponowna rejestracja autostartu z UAC)
; sie NIE wykonuja. Zwykla pierwsza instalacja dziala bez zmian.
Name: "desktopicon"; Description: "Utworz ikone na pulpicie"; GroupDescription: "Dodatkowe ikony:"; Check: not IsScyzorykUpdate
; Zaznaczone domyslnie - to docelowy, zalecany sposob uruchamiania Scyzoryka (patrz
; scyzoryk_final_deployment_plan w pamieci projektu: Zaplanowane zadanie Windows przy
; logowaniu KONKRETNEGO uzytkownika, NIE usluga LocalSystem - zachowuje dostep do
; zmapowanego dysku i domyslnej drukarki przypietych do sesji uzytkownika). Wymaga
; jednorazowego podniesienia uprawnien (UAC) WYLACZNIE do wpisu w pliku hosts - sama
; instalacja aplikacji pozostaje bez-adminowa niezaleznie od wyboru tego zadania.
Name: "autostart"; Description: "Uruchamiaj Scyzoryka automatycznie przy logowaniu (zalecane, wymaga jednorazowego okna UAC)"; GroupDescription: "Uruchamianie:"; Check: not IsScyzorykUpdate

[Files]
Source: "{#StagingDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
; Filename wskazuje na Scyzoryk.exe (natywny launcher) - bez IconFilename/IconIndex,
; zeby skrot i wpis na pasku zadan uzywaly tej samej, wbudowanej ikony samego EXE
; (repo nie ma jeszcze dedykowanego .ico - patrz launcher\Scyzoryk.Launcher.csproj
; i raport koncowy zadania "natywny launcher" - do zrobienia w przyszlosci).
Name: "{group}\{#MyAppName}"; Filename: "{app}\Scyzoryk.exe"; WorkingDir: "{app}"
Name: "{group}\Odinstaluj {#MyAppName}"; Filename: "{uninstallexe}"
; {userdesktop} (NIE {commondesktop}) - {commondesktop} to pulpit WSPOLNY wszystkich
; kont i wymaga uprawnien administratora do zapisu skrotu (IPersistFile::Save konczyl
; sie "Odmowa dostepu"/0x80070005 pod PrivilegesRequired=lowest - zlapane realnym
; testem instalacji, nie teoretycznie). {userdesktop} to pulpit BIEZACEGO uzytkownika,
; spojny z instalacja per-uzytkownik bez podnoszenia uprawnien.
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\Scyzoryk.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\instaluj-zaleznosci.cmd"; WorkingDir: "{app}"; StatusMsg: "Instalowanie skladnikow Scyzoryka (wymaga internetu, moze potrwac kilka minut)..."; Flags: runhidden waituntilterminated
; install-autostart.ps1 sam podnosi uprawnienia (jedno okno UAC) tylko dla siebie -
; ten krok uruchamia go BEZ elewacji, skrypt zajmie sie tym sam. -Wait wewnatrz
; skryptu (patrz jego komentarz) gwarantuje ze faktycznie skonczy prace zanim
; instalator pokaze "gotowe". Pomijany calkowicie jesli uzytkownik odznaczyl zadanie
; (Tasks: autostart) - w tym rowniez przy /VERYSILENT bez jawnego /MERGETASKS=autostart.
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\install-autostart.ps1"""; WorkingDir: "{app}"; StatusMsg: "Rejestrowanie autostartu przy logowaniu..."; Tasks: autostart; Check: not IsScyzorykUpdate; Flags: runhidden waituntilterminated
; Check: not IsScyzorykUpdate ponizej to dodatkowa (druga) warstwa obok
; skipifsilent - podczas /SCYZORYKUPDATE restart aplikacji robi WYLACZNIE
; scripts\run-update.ps1 (po zakonczeniu instalatora), nigdy ten krok.
; Bez argumentow = tryb normalny Scyzoryk.exe (odpal jesli trzeba, poczekaj na
; zdrowy serwer, otworz przegladarke raz) - patrz launcher\Scyzoryk.Launcher.
Filename: "{app}\Scyzoryk.exe"; Description: "Uruchom Scyzoryka teraz"; Check: not IsScyzorykUpdate; Flags: postinstall skipifsilent nowait

[UninstallRun]
; Wyrejestrowuje zadanie w Harmonogramie i wpis w hosts, JESLI byly zarejestrowane
; (skrypt sam sprawdza i nie robi nic jesli nie) - bez tego odinstalowanie
; zostawialoby osierocone zadanie wskazujace na usuniety folder. Musi isc PRZED
; usunieciem plikow (UninstallRun z definicji wykonuje sie przed [UninstallDelete]).
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\uninstall-autostart.ps1"""; Flags: runhidden; RunOnceId: "UninstallAutostart"
; Zatrzymuje TYLKO node.exe nalezacy do tej instalacji - Scyzoryk.exe --stop
; replikuje dokladnie logike match-po-pelnej-sciezce z dawnego stop-scyzoryk.ps1
; (patrz launcher\Scyzoryk.Launcher\ProcessManager.cs), zeby proces nie blokowal
; plikow podczas usuwania i zeby nie ubijac cudzych node.exe.
Filename: "{app}\Scyzoryk.exe"; Parameters: "--stop"; Flags: runhidden; RunOnceId: "StopScyzoryk"

[Code]
// Rozpoznaje ciche wywolanie z run-update.ps1 (patrz lib/updateService.js
// buildUpdaterInvocation): "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-
// /SCYZORYKUPDATE /DIR=...". W tym trybie: bez kreatora (juz zapewnia
// /VERYSILENT), bez ponownej rejestracji autostartu (UAC + plik hosts), bez
// ponownego pytania o skrot na pulpicie, bez postinstall-autorun aplikacji -
// restart robi wylacznie run-update.ps1 PO zakonczeniu tego instalatora.
// Zwykla (pierwsza) instalacja nie przekazuje tego parametru, wiec dziala
// dokladnie tak jak wczesniej.
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
; [Files] wie tylko o plikach ktore SAM instalator skopiowal - node_modules kazdej
; aplikacji (i Chromium dla Playwrighta) powstaja PO instalacji (sekcja [Run],
; instaluj-zaleznosci.cmd), a foldery robocze (apps\*\data, uploads, output, logs)
; powstaja dopiero przy pierwszym uzyciu apki. Bez tego wpisu odinstalowanie
; zostawialoby wszystkie te gigabajty danych na dysku. Usuwa caly folder instalacji.
Type: filesandordirs; Name: "{app}"
