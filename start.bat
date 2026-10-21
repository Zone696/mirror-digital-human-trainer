@echo off
chcp 65001 >nul
title 镜界 MIRROR · AI 数字人陪练
cd /d "%~dp0"

set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY ( where py >nul 2>nul && set "PY=py" )
if not defined PY (
  echo.
  echo   [错误] 未检测到 Python。请先安装 Python 3.9+ 并勾选 "Add to PATH"。
  echo   下载地址: https://www.python.org/downloads/
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动本地服务，浏览器将自动打开 http://127.0.0.1:8765
echo   关闭本窗口即可停止服务。
echo.
%PY% main.py
pause
