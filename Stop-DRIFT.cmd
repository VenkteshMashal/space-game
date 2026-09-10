@echo off
rem Stop-DRIFT.cmd - asks the running DRIFT host to stop and save. It talks to the
rem host's loopback admin endpoint; it never kills processes by name or pid.
setlocal
set "DRIFT_ROOT=%~dp0"

set "DRIFT_PS=powershell.exe"
where /q powershell.exe
if errorlevel 1 (
  set "DRIFT_PS=pwsh.exe"
  where /q pwsh.exe
  if errorlevel 1 (
    echo DRIFT needs Windows PowerShell 5.1 ^(or PowerShell 7^), which was not found on this PC.
    exit /b 5
  )
)

if not exist "%DRIFT_ROOT%scripts\start-host.ps1" (
  echo Cannot find "%DRIFT_ROOT%scripts\start-host.ps1".
  echo Keep Start-DRIFT.cmd, Stop-DRIFT.cmd and the scripts folder together in the DRIFT folder.
  exit /b 5
)

"%DRIFT_PS%" -NoProfile -ExecutionPolicy Bypass -File "%DRIFT_ROOT%scripts\start-host.ps1" -Stop %*
exit /b %ERRORLEVEL%
