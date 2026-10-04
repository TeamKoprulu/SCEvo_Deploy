@echo off
rem No arguments (or --no-open): the GUI. Anything else: the command line (run.cmd help).
if "%~1"=="" goto gui
if "%~1"=="--no-open" goto gui
node "%~dp0tools\cli.js" %*
exit /b %errorlevel%
:gui
node "%~dp0tools\app.js" %*
