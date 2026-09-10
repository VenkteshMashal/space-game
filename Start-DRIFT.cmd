@echo off
rem Start-DRIFT.cmd - starts the DRIFT LAN host. Everything resolves from this file's
rem own folder (%~dp0 ends with a backslash), so it works from any working directory
rem and from a path that contains spaces. All arguments pass straight through.
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

"%DRIFT_PS%" -NoProfile -ExecutionPolicy Bypass -File "%DRIFT_ROOT%scripts\start-host.ps1" %*
exit /b %ERRORLEVEL%
