@echo off
REM Double-click to start ingest watch mode
cd /d "%~dp0"
node ingest.js --watch
pause
