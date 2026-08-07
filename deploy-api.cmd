@echo off
REM ===========================================================================
REM C:\Stcky\cleo-api\deploy-api.cmd  -- THE API DEPLOY DOOR
REM
REM Written Jul 28 2026, same shape as the web deploy door and for the same
REM reason: a deploy that depends on where the shell happens to be standing is
REM a deploy that can ship the wrong folder. On Jul 28 the web one asked
REM "You are deploying your home directory. Continue?" and it meant it.
REM
REM So: the path is named once at the top, vercel gets it explicitly via --cwd,
REM and the script refuses to run unless this folder is genuinely the linked
REM cleo-api project.
REM
REM This deploys api.stcky.ai (project: cleo-api). It is NOT the same project
REM as the web front door -- that one is C:\Stcky\stcky-app\web\deploy.cmd.
REM ===========================================================================
setlocal EnableExtensions
set "API=C:\Stcky\cleo-api"

if not exist "%API%\vercel.json" (
  echo.
  echo   ABORT - %API%\vercel.json not found. Wrong path or moved folder.
  goto done
)
if not exist "%API%\.vercel\project.json" (
  echo.
  echo   ABORT - %API%\.vercel\project.json not found.
  echo   This folder is not linked to a Vercel project. Run: vercel link
  goto done
)

pushd "%API%"
if errorlevel 1 (
  echo.
  echo   ABORT - could not change directory to %API%
  goto done
)

echo.
echo   Deploying the API to production.
echo   project : cleo-api   (api.stcky.ai)
echo   from    : %CD%
echo.
vercel --cwd "%API%" --prod
popd

:done
echo.
pause
