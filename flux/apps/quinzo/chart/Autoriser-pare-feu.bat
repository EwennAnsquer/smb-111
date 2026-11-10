@echo off
chcp 65001 >nul
REM Autorise le port 3000 UNIQUEMENT sur les reseaux "prives" (pas sur les reseaux publics).
net session >nul 2>&1
if errorlevel 1 (
  echo Demande des droits administrateur...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
netsh advfirewall firewall delete rule name="Quinzo" >nul 2>&1
netsh advfirewall firewall add rule name="Quinzo" dir=in action=allow protocol=TCP localport=3000 profile=private
echo.
echo  OK : le port 3000 est autorise, seulement sur les reseaux prives.
echo  Ton Wi-Fi doit etre en profil "Prive" dans les parametres Windows.
echo  Pour retirer l'autorisation apres la partie : lance Retirer-pare-feu.bat
echo.
pause
