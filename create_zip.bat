@echo off
setlocal enabledelayedexpansion

rem ZIPファイルの名前と出力先
set VERSION=2.5
set ZIP_NAME=BookmarkHistorySearch_%VERSION%.zip
set OUTPUT_DIR=%~dp0

rem 除外するファイル名（完全一致・スペース区切り・引用符なし）
set EXCLUDE_FILES=.gitignore create_zip.bat

rem 除外するディレクトリ名（スペース区切り・引用符なし）
set EXCLUDE_DIRS=.git .claude screenshot temp_zip

rem 除外する拡張子（ドット付き・スペース区切り・引用符なし）
set EXCLUDE_EXTS=.zip

rem 一時作業ディレクトリを作成
set TEMP_DIR=%~dp0temp_zip
if exist "%TEMP_DIR%" rmdir /s /q "%TEMP_DIR%"
mkdir "%TEMP_DIR%"

rem 既存のZIPファイルを削除
if exist "%OUTPUT_DIR%%ZIP_NAME%" (
    echo ZIPファイルを削除: %OUTPUT_DIR%%ZIP_NAME%
    del "%OUTPUT_DIR%%ZIP_NAME%"
)

echo START FILE COPY
rem ルート直下のファイルをコピー（除外ファイル・除外拡張子を除く）
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
    )
)

echo START DIR COPY
rem ディレクトリをコピー（除外ディレクトリを除く）
for /d %%D in (*) do (
    set "EXCLUDE=0"
    for %%E in (%EXCLUDE_DIRS%) do (
        if /i "%%D"=="%%E" set "EXCLUDE=1"
    )
    if "!EXCLUDE!"=="0" (
        echo Copying directory: %%D
        xcopy "%%D" "%TEMP_DIR%\%%D" /s /e /i /q >nul
    )
)

echo START MAKE ZIP
rem ZIPファイルを作成
powershell -Command "Compress-Archive -Path '%TEMP_DIR%\*' -DestinationPath '%OUTPUT_DIR%%ZIP_NAME%'"

rem 一時作業ディレクトリを削除
rmdir /s /q "%TEMP_DIR%"

echo ZIPファイルが作成されました: %OUTPUT_DIR%%ZIP_NAME%
endlocal
pause
