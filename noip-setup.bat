@echo off
echo ========================================
echo     PANQUIZ NO-IP SETUP AUTOMATICO
echo ========================================
echo.

echo 1. Scaricando No-IP DUC...
curl -L "https://www.noip.com/client/windows/noip-duc-windows.exe" -o noip-duc.exe

echo.
echo 2. Avvia no-ip-duc.exe e inserisci:
echo    - Username No-IP
echo    - Password No-IP
echo    - Scegli il tuo hostname (es: panquiz.ddns.net)
echo.

echo 3. Poi avvia il tuo Panquiz server:
echo    cd C:\tuo\percorso\panquiz
echo    npm run web
echo.

echo 4. Il tuo sito sarà disponibile su:
echo    http://tuonome.ddns.net:3000
echo.

echo FATTO! Il tuo Panquiz sarà sempre online!
pause