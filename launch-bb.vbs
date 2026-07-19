' No-flash Stream Deck entry point. Runs launch-bb.ps1 completely hidden (no
' console window flash, unlike the .cmd). Point the Stream Deck "System -> Open"
' button at THIS file instead of launch-bb.cmd.
Set sh = CreateObject("WScript.Shell")
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & scriptDir & "launch-bb.ps1""", 0, False
