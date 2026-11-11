@echo off
chcp 65001 >nul
title Circuit TF Lab
cd /d "%~dp0"

rem 开发模式启动（需本机 Python 环境）；分发包请直接双击 CircuitTFLab.exe
set "PY=D:\Anaconda3\envs\py311\python.exe"
if not exist "%PY%" set "PY=python"

"%PY%" launcher.py
if errorlevel 1 pause
