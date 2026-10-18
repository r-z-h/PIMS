@echo off
setlocal
cd /d "%~dp0"

set "PY=%~dp0backend\.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

"%PY%" "%~dp0scripts\start_pims.py"
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo [ERROR] PIMS failed to start. Exit code: %CODE%
  echo.
  echo Please copy the messages above and report them.
  pause
)
endlocal
