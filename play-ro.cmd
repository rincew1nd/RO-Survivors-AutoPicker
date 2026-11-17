@echo off
setlocal

rem Isolated CloakBrowser launch: own profile, unpacked addon, game URL.
rem CloakBrowser is required; the addon is developed against that build.
rem Real Chrome/Edge settings are not touched.
rem --silent-debugger-extension-api hides the "started debugging this
rem browser" bar that the addon's trusted key replay would otherwise show.

set "EXT=%~dp0src"
set "PROFILE=%~dp0.cloak-profile"
set "URL=https://ro-survivors.com/"

set "BROWSER="
for /d %%D in ("%USERPROFILE%\.cloakbrowser\chromium-*") do if exist "%%~D\chrome.exe" set "BROWSER=%%~D\chrome.exe"
if not defined BROWSER (
  echo CloakBrowser binary not found in "%USERPROFILE%\.cloakbrowser".
  echo Run: npx -y cloakbrowser install
  pause
  exit /b 1
)

start "" "%BROWSER%" ^
  --user-data-dir="%PROFILE%" ^
  --load-extension="%EXT%" ^
  --disable-extensions-except="%EXT%" ^
  --ignore-gpu-blocklist ^
  --start-maximized ^
  --no-first-run ^
  --no-default-browser-check ^
  --disable-backgrounding-occluded-windows ^
  --disable-background-timer-throttling ^
  --disable-renderer-backgrounding ^
  --disable-features=IntensiveWakeUpThrottling ^
  --silent-debugger-extension-api ^
  "%URL%"

endlocal
