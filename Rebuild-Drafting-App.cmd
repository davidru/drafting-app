@echo off
rem ============================================================
rem  Check and package the Drafting App.
rem  Output: out\Drafting App-win32-x64\Drafting App.exe
rem
rem  Optional: set DEPLOY_DIR to a folder before running and the
rem  packaged app is mirrored there (close the app first).
rem ============================================================
title Rebuild Drafting App
cd /d "%~dp0"

call npm run check
if errorlevel 1 (
  echo.
  echo  CHECKS FAILED - fix the errors above before building.
  exit /b 1
)

call npm run package
if errorlevel 1 (
  echo.
  echo  BUILD FAILED - see the errors above.
  exit /b 1
)

if defined DEPLOY_DIR (
  echo.
  echo  Copying to: %DEPLOY_DIR%
  robocopy "out\Drafting App-win32-x64" "%DEPLOY_DIR%" /MIR /NFL /NDL /NJH /NJS /NP
  if errorlevel 8 (
    echo.
    echo  COPY FAILED - is the Drafting App still running?
    exit /b 1
  )
)

echo.
echo  Done.
