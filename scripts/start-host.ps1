# DRIFT LAN host launcher (Plan B2).
#
# Every path comes from this script's own folder, never from the caller's working
# directory, so Start-DRIFT.cmd works from anywhere - including a repo path that
# contains spaces.
#
# Exit codes: 0 ok, 2 not running, 3 shutdown or save failed, 4 port busy, 5 setup problem.

param(
  [int]$Port = 8080,
  [string]$Data = (Join-Path $(if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [Environment]::GetFolderPath('LocalApplicationData') }) 'DRIFT\host'),
  [string]$Adapter,
  [switch]$NoBrowser,
  [switch]$NonInteractive,
  [switch]$Setup,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$root = Split-Path -Parent $scriptDir
if (-not (Test-Path -LiteralPath (Join-Path $root 'package.json'))) {
  Write-Host "Cannot find the DRIFT project above this script (looked in $root)."
  Write-Host 'Keep scripts\start-host.ps1 inside the DRIFT folder, next to Start-DRIFT.cmd.'
  exit 5
}
Set-Location -LiteralPath $root

if (-not [System.IO.Path]::IsPathRooted($Data)) { $Data = Join-Path $root $Data }
$Data = [System.IO.Path]::GetFullPath($Data)
$runtimeFile = Join-Path $Data 'runtime.json'
$readyFile = Join-Path $Data 'ready.json'
$serveScript = Join-Path $root 'src\server\serve.ts'
$qrModule = Join-Path $root 'src\server\qr.ts'

function Test-PortBusy([int]$Candidate) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    if (-not $client.ConnectAsync('127.0.0.1', $Candidate).Wait(500)) { return $false }
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Get-NewestWriteTime([string[]]$Paths) {
  $newest = [datetime]::MinValue
  foreach ($path in $Paths) {
    if (-not (Test-Path -LiteralPath $path)) { continue }
    if ((Get-Item -LiteralPath $path).PSIsContainer) {
      $stamp = (Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction SilentlyContinue |
        Measure-Object -Property LastWriteTimeUtc -Maximum).Maximum
    } else {
      $stamp = (Get-Item -LiteralPath $path).LastWriteTimeUtc
    }
    if ($stamp -and [datetime]$stamp -gt $newest) { $newest = [datetime]$stamp }
  }
  return $newest
}

function Resolve-BunPath {
  if ($env:DRIFT_BUN -and (Test-Path -LiteralPath $env:DRIFT_BUN)) { return $env:DRIFT_BUN }
  $onPath = @(Get-Command bun -CommandType Application -ErrorAction SilentlyContinue) | Select-Object -First 1
  if ($onPath) { return $onPath.Source }
  $standardBun = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.bun\bin\bun.exe'
  if (Test-Path -LiteralPath $standardBun) { return $standardBun }
  if ($env:APPDATA) {
    $npmBun = Join-Path $env:APPDATA 'npm\node_modules\bun\bin\bun.exe'
    if (Test-Path -LiteralPath $npmBun) { return $npmBun }
  }
  return $null
}

function Install-Dependencies {
  Write-Host '  bun install --frozen-lockfile'
  # Redirecting native stderr under ErrorActionPreference=Stop throws a
  # NativeCommandError on PowerShell 5.1, which would hide bun's exit code.
  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $log = (& $bun install --frozen-lockfile 2>&1 | ForEach-Object { "$_" }) -join [Environment]::NewLine
  $code = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorAction
  if ($log.Trim()) { Write-Host $log.TrimEnd() }
  if ($code -eq 0) { return }
  if ($log -match '(?i)lockfile') {
    Write-Host '  bun.lock no longer matches package.json, so the frozen install was refused.'
    Write-Host '  bun install'
    & $bun install
    if ($LASTEXITCODE -ne 0) {
      Write-Host 'Dependency install failed. Fix the error above, then run Start-DRIFT.cmd again.'
      exit 5
    }
    return
  }
  Write-Host 'Dependency install failed. Fix the error above, then run Start-DRIFT.cmd again.'
  exit 5
}

function Build-App {
  Write-Host '  bun run build'
  & $bun run build
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'The build failed. Fix the error above, then run Start-DRIFT.cmd again.'
    exit 5
  }
}

function Write-GuestQr([string]$Url) {
  if (-not (Test-Path -LiteralPath $qrModule)) { return }
  # Single quotes only: double quotes inside a native argument get mangled on the
  # way into bun.
  $literal = $Url.Replace('\', '\\').Replace("'", "\'")
  $code = "import { encodeQr, qrToText } from '" + ([uri]$qrModule).AbsoluteUri + "';" +
    " console.log(qrToText(encodeQr('" + $literal + "')));"
  try {
    # Straight to the console: capturing would re-encode the half blocks.
    & $bun -e $code
    if ($LASTEXITCODE -eq 0) { $script:qrShown = $true }
  } catch {
    Write-Host "QR preview unavailable: $($_.Exception.Message)"
  }
}

# ---------------------------------------------------------------- stop the host

if ($Stop) {
  if (-not (Test-Path -LiteralPath $runtimeFile)) {
    Write-Host "DRIFT is not running: no runtime file at $runtimeFile."
    exit 2
  }
  $state = $null
  try { $state = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json } catch { $state = $null }
  if (-not $state -or -not $state.port -or -not $state.adminToken) {
    Write-Host "runtime.json is unreadable ($runtimeFile). Delete it if no host is running."
    exit 3
  }

  Write-Host "Asking the host on port $($state.port) to stop and save..."
  $stopped = $false
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($state.port)/api/shutdown" -Method Post `
      -ContentType 'application/json' -Body '{}' -UseBasicParsing -TimeoutSec 30 `
      -Headers @{ Authorization = "Bearer $($state.adminToken)" }
    $stopped = $true
    $body = $null
    if ($response.Content) { try { $body = $response.Content | ConvertFrom-Json } catch { $body = $null } }
    if ($body) {
      foreach ($flag in @('ok', 'saved', 'acknowledged')) {
        if (($body.PSObject.Properties.Name -contains $flag) -and -not $body.$flag) { $stopped = $false }
      }
    }
  } catch {
    Write-Host "The host did not answer: $($_.Exception.Message)"
    $stopped = $false
  }

  if (-not $stopped) {
    Write-Host 'The host refused to stop or did not acknowledge the save. It may still be running.'
    exit 3
  }
  Remove-Item -LiteralPath $runtimeFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $readyFile -Force -ErrorAction SilentlyContinue
  Write-Host 'Host stopped and the save was acknowledged.'
  exit 0
}

# ------------------------------------------------------------------- preflight

if ($Port -lt 1024 -or $Port -gt 65535) {
  Write-Host "Port $Port is outside the usable range 1024-65535."
  exit 5
}

New-Item -ItemType Directory -Force -Path $Data | Out-Null
if (Test-Path -LiteralPath $runtimeFile) {
  $previous = $null
  try { $previous = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json } catch { $previous = $null }
  if ($previous -and $previous.pid -and (Get-Process -Id ([int]$previous.pid) -ErrorAction SilentlyContinue)) {
    Write-Host "A DRIFT host is already running for this data folder (pid $($previous.pid), port $($previous.port))."
    Write-Host 'Stop it with Stop-DRIFT.cmd before starting another one.'
    exit 5
  }
  Remove-Item -LiteralPath $runtimeFile -Force
  Remove-Item -LiteralPath $readyFile -Force -ErrorAction SilentlyContinue
  Write-Host 'Removed a leftover runtime.json from a host that is no longer running.'
}

$bun = Resolve-BunPath
if (-not $bun) {
  Write-Host 'Bun was not found, and the DRIFT host runs on it.'
  Write-Host 'Install Bun from https://bun.sh, or point DRIFT_BUN at bun.exe, then try again.'
  Write-Host 'Looked at: %DRIFT_BUN%, bun on PATH, %APPDATA%\npm\node_modules\bun\bin\bun.exe'
  exit 5
}
$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$bunVersion = (& $bun --version 2>$null | Out-String).Trim()
$ErrorActionPreference = $previousErrorAction
if (-not $bunVersion) {
  Write-Host "Bun at $bun could not report a version. Reinstall it, or set DRIFT_BUN to a working bun.exe."
  exit 5
}
Write-Host "Bun $bunVersion ($bun)"

$sourcePaths = @(
  (Join-Path $root 'src'),
  (Join-Path $root 'public'),
  (Join-Path $root 'index.html'),
  (Join-Path $root 'vite.config.ts'),
  (Join-Path $root 'tsconfig.json'),
  (Join-Path $root 'package.json'),
  (Join-Path $root 'bun.lock')
)

$nodeModules = Join-Path $root 'node_modules'
$depsCurrent = $false
if (Test-Path -LiteralPath $nodeModules) {
  $pkg = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
  $declared = @()
  foreach ($group in @($pkg.dependencies, $pkg.devDependencies)) {
    if ($group) { $declared += $group.PSObject.Properties.Name }
  }
  $missing = @($declared | Where-Object { -not (Test-Path -LiteralPath (Join-Path $nodeModules $_)) })
  # A missing lockfile counts as stale, so bun install can write one.
  $lockFile = Join-Path $root 'bun.lock'
  $lockStamp = if (Test-Path -LiteralPath $lockFile) { (Get-Item -LiteralPath $lockFile).LastWriteTimeUtc } else { [datetime]::MaxValue }
  $depsCurrent = ($missing.Count -eq 0) -and ($lockStamp -le (Get-Item -LiteralPath $nodeModules).LastWriteTimeUtc)
  if (-not $depsCurrent -and $missing.Count) { Write-Host "Missing packages: $($missing -join ', ')" }
}

$distIndex = Join-Path $root 'dist\index.html'
$buildCurrent = (Test-Path -LiteralPath $distIndex) -and
  ((Get-Item -LiteralPath $distIndex).LastWriteTimeUtc -ge (Get-NewestWriteTime $sourcePaths))

if ($depsCurrent -and $buildCurrent) {
  Write-Host 'Dependencies and build are current; starting without touching the network.'
} else {
  Write-Host 'Preparing the host (first run, or the project changed since the last build)...'
  if (-not $depsCurrent) { Install-Dependencies }
  if (-not $buildCurrent) { Build-App }
  Write-Host 'Host prepared.'
}

if ($Setup) {
  Write-Host 'Setup finished. Run Start-DRIFT.cmd to host a match.'
  exit 0
}

if (Test-PortBusy $Port) {
  if ($NonInteractive) {
    Write-Host "Port $Port is already in use. Pick another one with -Port."
    exit 4
  }
  Write-Host "Port $Port is already in use by another program."
  Write-Host 'Press Enter for the next free port, or type a port number between 1024 and 65535.'
  $free = $null
  while (-not $free) {
    $answer = Read-Host 'Port'
    if ([string]::IsNullOrWhiteSpace($answer)) {
      $candidate = $Port + 1
      while ($candidate -le 65535 -and (Test-PortBusy $candidate)) { $candidate++ }
      if ($candidate -gt 65535) {
        Write-Host 'No free port was found above the requested one.'
        exit 4
      }
      $free = $candidate
    } else {
      $parsed = 0
      if ([int]::TryParse($answer.Trim(), [ref]$parsed) -and $parsed -ge 1024 -and $parsed -le 65535 -and
        -not (Test-PortBusy $parsed)) {
        $free = $parsed
      } else {
        Write-Host 'That port is busy or outside 1024-65535. Try another one.'
      }
    }
  }
  $Port = $free
  Write-Host "Using port $Port."
}

# --------------------------------------------------------------------- launch

# Start-Process joins its argument list with spaces, so anything with a space
# (this repo lives in one) has to be quoted by hand.
$serveArgs = @($serveScript, '--port', "$Port", '--data', $Data, '--dist', (Join-Path $root 'dist'),
  '--ready-file', $readyFile, '--non-interactive')
if ($Adapter) { $serveArgs += @('--adapter', $Adapter) }
$argLine = ($serveArgs | ForEach-Object { if ($_ -match '\s') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '

$hostProcess = Start-Process -FilePath $bun -ArgumentList $argLine -WorkingDirectory $root -PassThru
Write-Host "Host started in its own window (pid $($hostProcess.Id), port $Port)."

$state = $null
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  if (Test-Path -LiteralPath $runtimeFile) {
    try { $state = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json } catch { $state = $null }
    if ($state -and $state.guestOrigin -and $state.operatorUrl) { break }
    $state = $null
  }
  if ($hostProcess.HasExited) { break }
  Start-Sleep -Milliseconds 250
}

if (-not $state) {
  if ($hostProcess.HasExited) {
    $code = $hostProcess.ExitCode
    Write-Host "The host stopped with exit code $code before it was ready."
    if ($code -eq 4) { Write-Host "Port $Port is already in use." }
    if ($code -eq 2) { Write-Host 'The host is not running.' }
    if ($code -eq 3) { Write-Host 'The host could not shut down cleanly.' }
    exit $(if (@(2, 3, 4) -contains $code) { $code } else { 5 })
  }
  Write-Host 'The host has not reported ready after 30 seconds; its own window shows what it is doing.'
  exit 5
}

$guestUrl = [string]$state.guestOrigin
if (-not $guestUrl.EndsWith('/')) { $guestUrl += '/' }
$operatorUrl = [string]$state.operatorUrl
$operatorAddress = ($operatorUrl -split '#', 2)[0]

Write-Host ''
Write-Host "Guests:   $guestUrl"
Write-Host "Operator: ${operatorAddress}#op=<hidden>"
Write-Host '          The operator token is a secret. It is in the host window and in the browser tab below.'
Write-Host ''

$script:qrShown = $false
Write-GuestQr $guestUrl
if (-not $script:qrShown) { Write-Host $guestUrl }

$clipboard = Get-Command Set-Clipboard -ErrorAction SilentlyContinue
if ($clipboard) {
  try { Set-Clipboard -Value $guestUrl } catch { $clipboard = $null }
}
if ($clipboard) {
  Write-Host 'Guest address copied to the clipboard.'
} else {
  Write-Host 'Select and copy this address:'
  Write-Host $guestUrl
}

if (-not $NoBrowser) {
  try {
    Start-Process $operatorUrl
  } catch {
    Write-Host "The browser did not open automatically: $($_.Exception.Message)"
  }
}

Write-Host ''
Write-Host 'Closing the browser does not stop the host. Run Stop-DRIFT.cmd when the match is over.'
exit 0
