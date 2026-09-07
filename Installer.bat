@echo off
title CutLocal - installation
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Installer.ps1"
