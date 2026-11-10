@echo off
chcp 65001 >nul
title Quinzo (Docker)
cd /d "%~dp0"
if "%QUINZO_PORT%"=="" set QUINZO_PORT=3000

where docker >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Docker n'est pas installe. Installe Docker Desktop : https://www.docker.com/products/docker-desktop/
  echo.
  pause
  exit /b 1
)
docker info >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Docker Desktop n'est pas demarre. Lance-le, attends qu'il soit pret, puis relance ce fichier.
  echo.
  pause
  exit /b 1
)

REM Adresse IP de ce PC sur le reseau (carte avec une passerelle = Wi-Fi ou Ethernet)
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "@((Get-NetIPConfiguration).Where({$_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up'})[0].IPv4Address.IPAddress)[0]"`) do set PUBLIC_HOST=%%i
echo Adresse de ce PC sur le reseau : %PUBLIC_HOST%

if not exist data mkdir data
echo Demarrage du conteneur (la premiere fois, ca peut prendre une minute)...
docker compose up -d --build
if errorlevel 1 (
  echo Le demarrage a echoue.
  pause
  exit /b 1
)

REM Laisse le serveur demarrer puis ouvre l'ecran hote (page de connexion)
timeout /t 3 /nobreak >nul
start "" "http://localhost:%QUINZO_PORT%/host"

echo.
echo  ==========================================================
echo   Quinzo tourne dans Docker !
echo   Ecran hote : http://localhost:%QUINZO_PORT%/host
echo   Tes potes  : http://%PUBLIC_HOST%:%QUINZO_PORT%
echo.
echo   Pour arreter : lance "Docker - Arreter.bat"
echo  ==========================================================
echo.
pause
