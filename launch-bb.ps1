# One-press launcher for the Big Brother / Paramount+ live-feed setup.
#   1. Starts the Feed Goblin bridge if it isn't already running.
#   2. Opens (or focuses) the Paramount+ Chrome app.
# Wire a Stream Deck "System -> Open" button to launch-bb.cmd (which runs this).

$ErrorActionPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgeDir = Join-Path $here 'bridge'

# --- Bridge port: read from config.json, fall back to the default ---
$port = 8787
$cfgPath = Join-Path $bridgeDir 'config.json'
if (Test-Path $cfgPath) {
  $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
  if ($cfg.port) { $port = [int]$cfg.port }
}

# --- Start the bridge only if nothing is already listening on that port ---
$listening = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
if (-not $listening) {
  # Minimized (not hidden) with a named process, so it sits in the taskbar as
  # "BB Live Feed Bridge" — easy to find, check logs on, and close to stop.
  Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $bridgeDir -WindowStyle Minimized
}

# --- Open / focus the Paramount+ Chrome app ---
# Launching chrome_proxy --app-id when the app is already open spawns a DUPLICATE
# window, so first look for an existing app process (identified by the app-id in
# its command line). If found, just bring it to the front; only launch when none
# exists.
$appId = 'lkdalgcgemlgacpgccpimfffecbkicfl'
$existing = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.CommandLine -like "*app-id=$appId*" })

if ($existing.Count -gt 0) {
  try { (New-Object -ComObject WScript.Shell).AppActivate($existing[0].ProcessId) | Out-Null } catch { }
} else {
  $chromeProxy = 'C:\Program Files\Google\Chrome\Application\chrome_proxy.exe'
  if (Test-Path $chromeProxy) {
    Start-Process -FilePath $chromeProxy -ArgumentList '--profile-directory=Default', "--app-id=$appId"
  }
}

# --- Ask the extension to navigate the app to Big Brother ---
# The app opens on the P+ homepage, so tell the extension to redirect the tab.
# On a COLD start Chrome has to boot, load the extension, and let the service
# worker connect to the bridge first, so retry over a generous window (~18s).
# Each /goto is a no-op once the tab is already on the BB page, so the extra
# attempts after it lands are harmless.
$token = $null
if (Test-Path $cfgPath) {
  $token = (Get-Content $cfgPath -Raw | ConvertFrom-Json).token
}
if ($token) {
  $gotoUri = "http://127.0.0.1:$port/goto"
  for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Milliseconds 1500
    try {
      Invoke-RestMethod -Uri $gotoUri -Headers @{ 'X-Feed-Token' = $token } -TimeoutSec 2 | Out-Null
    } catch { }
  }
}
