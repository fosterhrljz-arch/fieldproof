@echo off
setlocal
pushd "%~dp0" || goto :failed
where.exe node.exe >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 or newer from https://nodejs.org, then double-click this file again.
  pause
  exit /b 1
)
node -e "process.exit(+process.versions.node.split('.')[0]>=24?0:1)"
if errorlevel 1 (
  echo FieldProof requires Node.js 24 or newer.
  pause
  exit /b 1
)
if not exist "team-dist/index.html" (
  node build-team.mjs
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo Keep this window open. Use the address shown below to open FieldProof in your browser.
node --env-file-if-exists=.env server.mjs
if errorlevel 1 goto :failed
popd
exit /b 0

:failed
echo FieldProof could not start. Check the message above, your Node.js version, and whether port 8740 is already in use.
pause
exit /b 1
