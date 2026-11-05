' Runs Crew Office for a crewoffice:// link with no console window. See register-protocol.ps1.
' Arguments: the path to node.exe, then the link. A quote in the link cannot break out of the one
' argument it arrives in, because there are none left by the time the command line is built.
Option Explicit
Dim fso, shell, here, app, node, link
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
If WScript.Arguments.Count < 2 Then WScript.Quit 1
node = WScript.Arguments(0)
link = Replace(WScript.Arguments(1), """", "")
here = fso.GetParentFolderName(WScript.ScriptFullName)
app = fso.GetParentFolderName(fso.GetParentFolderName(here))
shell.CurrentDirectory = app
shell.Run """" & node & """ """ & app & "\bin\crew-app.cjs"" """ & link & """", 0, False
