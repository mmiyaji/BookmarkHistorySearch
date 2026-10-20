@echo off
setlocal enabledelayedexpansion
pushd "%~dp0" || exit /b 1

rem Package name and output directory
set VERSION=2.7
set ZIP_NAME=BookmarkHistorySearch_%VERSION%.zip
set OUTPUT_DIR=%~dp0
set STAGED_ZIP=%~dp0%ZIP_NAME%.tmp.zip

rem Exact file names to exclude
set EXCLUDE_FILES=.gitignore create_zip.bat package.json package-lock.json temp_zip

rem Directory names to exclude
set EXCLUDE_DIRS=.git .claude screenshot tests temp_zip .zip_build_2_7

rem File extensions to exclude
set EXCLUDE_EXTS=.zip

rem Create an isolated build directory inside this repository
set TEMP_DIR=%~dp0.zip_build_2_7
if exist "%TEMP_DIR%\NUL" rmdir /s /q "%TEMP_DIR%"
if exist "%TEMP_DIR%" goto :fail
mkdir "%TEMP_DIR%"
if errorlevel 1 goto :fail

rem Preserve the existing package until the replacement is complete
if exist "%STAGED_ZIP%" del "%STAGED_ZIP%"

echo START FILE COPY
rem Copy root files except excluded names and extensions
for %%F in (*.*) do (
    set "EXCLUDE=0"
    for %%E in (%EXCLUDE_FILES%) do (
        if /i "%%~nxF"=="%%E" set "EXCLUDE=1"
    )
    for %%X in (%EXCLUDE_EXTS%) do (
        if /i "%%~xF"=="%%X" set "EXCLUDE=1"
    )
    if "!EXCLUDE!"=="0" (
        echo Copying file: %%F
        copy "%%F" "%TEMP_DIR%" >nul
        if errorlevel 1 goto :fail
    )
)

echo START DIR COPY
rem Copy directories except excluded names
for /d %%D in (*) do (
    set "EXCLUDE=0"
    for %%E in (%EXCLUDE_DIRS%) do (
        if /i "%%D"=="%%E" set "EXCLUDE=1"
    )
    if "!EXCLUDE!"=="0" (
        echo Copying directory: %%D
        xcopy "%%D" "%TEMP_DIR%\%%D" /s /e /i /q >nul
        if errorlevel 2 goto :fail
    )
)

echo START MAKE ZIP
rem Build a staged ZIP and replace the previous package only on success
powershell -NoProfile -Command "Compress-Archive -Path '%TEMP_DIR%\*' -DestinationPath '%STAGED_ZIP%'"
if errorlevel 1 goto :fail
if not exist "%STAGED_ZIP%" goto :fail

move /y "%STAGED_ZIP%" "%OUTPUT_DIR%%ZIP_NAME%" >nul
if errorlevel 1 goto :fail

rem Remove the isolated build directory
rmdir /s /q "%TEMP_DIR%"

echo ZIP package created: %OUTPUT_DIR%%ZIP_NAME%
popd
endlocal
exit /b 0

:fail
echo ZIP package creation failed.
if exist "%STAGED_ZIP%" del "%STAGED_ZIP%"
if exist "%TEMP_DIR%" rmdir /s /q "%TEMP_DIR%"
popd
endlocal
exit /b 1
