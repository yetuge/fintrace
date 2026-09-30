Option Explicit
Dim shell, files, root, command, result
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
command = "node " & Chr(34) & files.BuildPath(root, "scripts\start-desktop.mjs") & Chr(34)
On Error Resume Next
result = shell.Run(command, 0, True)
If Err.Number <> 0 Then
  MsgBox "Unable to start FinTrace. Please install Node.js 24 and reopen this launcher.", 16, "FinTrace"
ElseIf result <> 0 Then
  MsgBox "FinTrace could not start. See logs\desktop\launcher.log in the project folder.", 16, "FinTrace"
End If
