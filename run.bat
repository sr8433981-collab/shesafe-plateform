@echo off
REM ==========================================================================
REM  SheSafe - Windows launcher
REM  Starts the Flask API and opens the browser. Python 3.10+ required.
REM ==========================================================================
setlocal
cd /d "%~dp0"

echo.
echo  ======================================================
echo     SheSafe - Personal Safety ^& Emergency Response
echo  ======================================================
echo.

where python >nul 2>nul
if %ERRORLEVEL% EQU 0 goto :python

where py >nul 2>nul
if %ERRORLEVEL% EQU 0 goto :py

echo  [ERROR] Python 3.10 or newer was not found on PATH.
echo.
echo    Install Python from https://www.python.org/downloads/
echo    and be sure to tick "Add Python to PATH" during setup.
echo.
pause
exit /b 1

:py
py -3 backend\wsgi.py
goto :done

:python
REM Use the project virtualenv when it exists, so dependencies are isolated.
if exist ".venv\Scripts\python.exe" (
    .venv\Scripts\python.exe backend\wsgi.py
) else (
    python backend\wsgi.py
)

:done
echo.
echo  SheSafe stopped.
pause
endlocal
