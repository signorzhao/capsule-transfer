Option Explicit

Dim shell, reaperExe, rppPath, cmd

If WScript.Arguments.Count < 2 Then
  WScript.Quit 2
End If

Set shell = CreateObject("WScript.Shell")
reaperExe = WScript.Arguments.Item(0)
rppPath = WScript.Arguments.Item(1)
shell.Environment("PROCESS")("CAPSULE_TRANSFER_BRIDGE_DISABLED") = "1"

cmd = """" & reaperExe & """ -renderproject """ & rppPath & """ -nosplash -ignoreerrors -close"

' 7 = start minimized and do not activate. The third argument waits until the
' render process exits so the bridge result reflects the real preview outcome.
WScript.Quit shell.Run(cmd, 7, True)
