@echo off
title SheSafe - Women Safety System
echo ======================================================
echo    SheSafe - Women Safety & Emergency System
echo ======================================================
echo.
echo Starting Backend Server...
echo.

where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo [OK] Node.js detected. Launching Node server...
    start http://localhost:3000
    node backend/server.js
    pause
    exit /b
)

where python >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo [OK] Python detected. Launching Python Flask server...
    start http://localhost:5000
    python backend/app.py
    pause
    exit /b
)

echo [INFO] Neither Node.js nor Python detected in PATH.
echo Opening frontend directly in your default browser...
start frontend/index.html
pause
