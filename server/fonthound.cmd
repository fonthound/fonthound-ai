@echo off
rem FontHound's MCP server for Claude Code on Windows. Claude Code starts this
rem file (see .mcp.json); it runs FontHound's own program as the server
rem ("fonthound.exe --mcp"), so no Node.js is needed. A FontHound from before
rem the Claude connection has no --mcp: then the plugin's JavaScript server
rem (fonthound-mcp.js) runs if Node.js is installed. Without either, it says
rem so on stderr and stops; the skill then tells Claude to have the user
rem install or update FontHound.
rem
rem FontHound is found where it wrote its own path (%APPDATA%\FontHound\
rem app-path.txt), else in its install folders. Only a FontHound with
rem claude\fonthound-mcp.txt beside its program knows --mcp. This file only
rem checks files and starts one program: no registry, no process list.
rem No labels or blocks: it must work with either line ending, and with
rem brackets in a folder name.
setlocal
set "FH="
set "FHP="
set "NODE="
if defined FONTHOUND_EXE for %%F in ("%FONTHOUND_EXE%") do if exist "%%~fF" if exist "%%~dpFclaude\fonthound-mcp.txt" set "FH=%%~fF"
if not defined FH if exist "%APPDATA%\FontHound\app-path.txt" set /p FHP=<"%APPDATA%\FontHound\app-path.txt"
if not defined FH if defined FHP for %%F in ("%FHP%") do if exist "%%~fF" if exist "%%~dpFclaude\fonthound-mcp.txt" set "FH=%%~fF"
if not defined FH for %%F in ("%LOCALAPPDATA%\Programs\FontHound\fonthound.exe" "%ProgramFiles%\FontHound\fonthound.exe") do if not defined FH if exist "%%~fF" if exist "%%~dpFclaude\fonthound-mcp.txt" set "FH=%%~fF"
if defined FH "%FH%" --mcp
if defined FH exit /b %errorlevel%
for %%N in (node.exe) do set "NODE=%%~$PATH:N"
if defined NODE "%NODE%" "%~dp0fonthound-mcp.js"
if defined NODE exit /b %errorlevel%
>&2 echo [fonthound] Claude connects through FontHound's own program, and this computer has no FontHound that can do it. Install or update FontHound: https://fonthound.app/download
exit /b 1
