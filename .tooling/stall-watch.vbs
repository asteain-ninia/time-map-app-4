' Launch stall-watch.ps1 with no visible window (Task Scheduler would otherwise flash a console
' every 10 minutes and steal focus from the owner).
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & dir & "\stall-watch.ps1""", 0, False
