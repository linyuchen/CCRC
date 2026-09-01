@echo off
node "%~dp0..\plugin\dist\cli.cjs" %*
exit /b %errorlevel%
