Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
exe = base & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(exe) Then
  MsgBox "Gendo is not installed correctly: Electron is missing." & vbCrLf & "Run npm install in " & base, 16, "Gendo"
  WScript.Quit 1
End If
shell.CurrentDirectory = base
shell.Run """" & exe & """ """ & base & """", 0, False
