@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (
  echo Python 3.11 or newer is required. Install it from https://www.python.org/downloads/
  pause
  exit /b 1
)
if not exist ".venv-studio\Scripts\python.exe" (
  py -3 -m venv .venv-studio
  if errorlevel 1 goto failed
  .venv-studio\Scripts\python.exe -m pip install -r studio\requirements.txt
  if errorlevel 1 goto failed
)
.venv-studio\Scripts\python.exe -m studio %*
if errorlevel 1 goto failed
exit /b 0
:failed
echo Studio could not start. Read the error above and the setup notes in studio\README.md.
pause
exit /b 1
