@echo off
chcp 65001 >nul
REM Supprime l'autorisation du port 3000 creee par Autoriser-pare-feu.bat
net session >nul 2>&1
if errorlevel 1 (
  echo Demande des droits administrateur...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
netsh advfirewall firewall delete rule name="Quinzo"
echo.
echo  OK : l'autorisation Quinzo a ete retiree du pare-feu.
echo.
pause
