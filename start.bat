@echo off
echo =============================================
echo    Local File Share - Windows Launcher
echo =============================================
echo.
echo Starting the file sharing server...
echo.

REM Check if Python is installed
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Python is not installed or not in PATH
    echo Please install Python 3.6+ from https://python.org
    echo.
    pause
    exit /b 1
)

REM Start the server
echo Python found. Starting server...
echo.
python server.py

pause