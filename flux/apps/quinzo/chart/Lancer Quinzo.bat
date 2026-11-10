@echo off
chcp 65001 >nul
title Quinzo - serveur de quiz
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js n'est pas installe sur ce PC.
  echo  Installe la version LTS depuis https://nodejs.org puis relance ce fichier.
  echo.
  start "" "https://nodejs.org/fr/download"
  pause
  exit /b 1
)

if not exist "node_modules\socket.io" (
  echo Installation des dependances, une seule fois...
  call npm install --omit=dev
  if errorlevel 1 (
    echo L'installation a echoue. Verifie ta connexion internet.
    pause
    exit /b 1
  )
)

node server.js
pause
