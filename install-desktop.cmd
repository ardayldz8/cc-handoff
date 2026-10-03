@echo off
rem Registers cc-handoff in Claude Desktop. Double-click this file in Explorer.
rem Extra arguments are passed through, e.g. install-desktop.cmd --dry-run
setlocal
set "EXITCODE=1"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20 or newer from https://nodejs.org and try again.
  echo Node.js bulunamadi. https://nodejs.org adresinden Node.js 20 veya ustunu kurup tekrar dene.
) else (
  node "%~dp0scripts\install-desktop.mjs" %*
  call set "EXITCODE=%%errorlevel%%"
)

echo.
echo Press any key to continue . . . / Devam etmek icin bir tusa bas . . .
pause >nul
endlocal & exit /b %EXITCODE%
