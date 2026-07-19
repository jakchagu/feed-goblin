@echo off
rem Stream Deck entry point. Point a "System -> Open" button at this file.
rem It runs launch-bb.ps1 hidden, which starts the bridge (if needed) and opens
rem the Paramount+ app.
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launch-bb.ps1"
