@echo off
title CutLocal - editeur video local
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js est introuvable.
  echo   Installez-le depuis https://nodejs.org  puis relancez ce fichier.
  echo.
  pause
  exit /b 1
)

echo.
echo   Demarrage de CutLocal...
echo   Laissez cette fenetre ouverte pendant le montage.
echo   Fermez-la (ou Ctrl+C) pour arreter.
echo.

node server\server.js
if errorlevel 1 pause
