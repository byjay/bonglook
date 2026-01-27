@echo off
TITLE BongLook AI Outlook Launcher
SETLOCAL

echo ========================================
echo   BongLook AI Outlook Launcher
echo ========================================
echo.

node -v >nul 2>&1
if errorlevel 1 goto NO_NODE

:: Check node_modules
if exist "node_modules\" goto RUN_DEV

echo [1/2] 필수 모듈이 없습니다. 설치를 시작합니다...
call npm install
if errorlevel 1 goto ERR_INSTALL

:RUN_DEV
echo [2/2] 시스템을 시작합니다...
echo.
echo Client:  http://localhost:35173
echo Backend: http://localhost:33001
echo.

:: 브라우저 비동기 실행 (변경된 포트로 실행)
start http://localhost:35173

:: 로컬 백엔드 실행 (Agent 미사용 시 필요)
if exist "server.js" (
    echo [INFO] 로컬 프록시 서버를 백그라운드에서 실행합니다 (Port: 33001)...
    start "BongLook_Backend" /min node server.js
)

:: Vite 실행
call npm run dev
goto END

:NO_NODE
echo [오류] Node.js가 설치되어 있지 않습니다.
echo https://nodejs.org/ 에서 LTS 버전을 설치해 주세요.
pause
goto END

:ERR_INSTALL
echo [오류] 모듈 설치 중 에러가 발생했습니다.
pause
goto END

:END
ENDLOCAL
pause
