' Uruchamia STARTUJ-SCYZORYK-CICHO.cmd bez widocznego okna konsoli (parametr "0" w
' WshShell.Run) - uzywane przez Zaplanowane zadanie Windows (patrz
' scripts/install-autostart.ps1), zeby autostart przy logowaniu nie migal czarnym
' oknem cmd.exe. Sciezka do repo liczona wzgledem polozenia tego pliku, nie na
' sztywno, zeby dzialalo nawet po przeniesieniu/zmianie nazwy rozpakowanego folderu.
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
repoRoot = fso.GetParentFolderName(scriptDir)

Set shell = CreateObject("WScript.Shell")
shell.Run """" & repoRoot & "\STARTUJ-SCYZORYK-CICHO.cmd""", 0, False
