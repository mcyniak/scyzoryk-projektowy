; Instalator Scyzoryka Projektowego (Inno Setup).
;
; Nie jest kompilowany recznie z zawartoscia repo - oczekuje, ze scripts\build-installer.ps1
; przygotowal wczesniej katalog StagingDir zawierajacy:
;   - czysty eksport repo (git archive HEAD, ten sam zestaw plikow co scripts\build-package.js
;     produkuje dla ZIP-a, patrz .gitattributes/.gitignore - bez node_modules/danych/.claude/.serena),
;   - node-runtime\ - bundlowany, portable Node.js (Windows x64), zeby uzytkownik koncowy
;     NIE musial miec Node.js zainstalowanego globalnie na komputerze,
;   - Uruchom-Scyzoryk.cmd i instaluj-zaleznosci.cmd (installer\ w repo) skopiowane do korzenia.
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
Name: "desktopicon"; Description: "Utworz ikone na pulpicie"; GroupDescription: "Dodatkowe ikony:"

[Files]
Source: "{#StagingDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\Uruchom-Scyzoryk.cmd"; WorkingDir: "{app}"; IconFilename: "{sys}\shell32.dll"; IconIndex: 43
Name: "{group}\Odinstaluj {#MyAppName}"; Filename: "{uninstallexe}"
; {userdesktop} (NIE {commondesktop}) - {commondesktop} to pulpit WSPOLNY wszystkich
; kont i wymaga uprawnien administratora do zapisu skrotu (IPersistFile::Save konczyl
; sie "Odmowa dostepu"/0x80070005 pod PrivilegesRequired=lowest - zlapane realnym
; testem instalacji, nie teoretycznie). {userdesktop} to pulpit BIEZACEGO uzytkownika,
; spojny z instalacja per-uzytkownik bez podnoszenia uprawnien.
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\Uruchom-Scyzoryk.cmd"; WorkingDir: "{app}"; IconFilename: "{sys}\shell32.dll"; IconIndex: 43; Tasks: desktopicon

[Run]
Filename: "{app}\instaluj-zaleznosci.cmd"; WorkingDir: "{app}"; StatusMsg: "Instalowanie skladnikow Scyzoryka (wymaga internetu, moze potrwac kilka minut)..."; Flags: runhidden waituntilterminated
Filename: "{app}\Uruchom-Scyzoryk.cmd"; Description: "Uruchom Scyzoryka teraz"; Flags: postinstall skipifsilent nowait

[UninstallRun]
; Zatrzymuje TYLKO node.exe nalezacy do tej instalacji (patrz scripts\stop-scyzoryk.ps1),
; zeby proces nie blokowal plikow podczas usuwania i zeby nie ubijac cudzych node.exe.
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\stop-scyzoryk.ps1"""; Flags: runhidden; RunOnceId: "StopScyzoryk"

[UninstallDelete]
; [Files] wie tylko o plikach ktore SAM instalator skopiowal - node_modules kazdej
; aplikacji (i Chromium dla Playwrighta) powstaja PO instalacji (sekcja [Run],
; instaluj-zaleznosci.cmd), a foldery robocze (apps\*\data, uploads, output, logs)
; powstaja dopiero przy pierwszym uzyciu apki. Bez tego wpisu odinstalowanie
; zostawialoby wszystkie te gigabajty danych na dysku. Usuwa caly folder instalacji.
Type: filesandordirs; Name: "{app}"
