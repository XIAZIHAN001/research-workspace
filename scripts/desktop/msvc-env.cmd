@echo off
rem Runs a command inside the local Visual Studio x64 developer environment.
rem Used by the Phase 10 desktop build; nothing here is required to run the app.
setlocal
if "%RW_VS_PATH%"=="" set "RW_VS_PATH=D:\VS CODE"
if "%RUSTUP_HOME%"=="" set "RUSTUP_HOME=D:\Rust\rustup"
if "%CARGO_HOME%"=="" set "CARGO_HOME=D:\Rust\cargo"

call "%RW_VS_PATH%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 (
  echo Failed to initialise the Visual Studio x64 environment at "%RW_VS_PATH%".
  exit /b 1
)
set "PATH=%CARGO_HOME%\bin;%PATH%"
rem vcvars64 also sets INCLUDE/LIB/LIBPATH. They must survive endlocal, or cl.exe starts
rem successfully and then fails to find its headers with a bare exit code 2.
endlocal & set "PATH=%PATH%" & set "RUSTUP_HOME=%RUSTUP_HOME%" & set "CARGO_HOME=%CARGO_HOME%" & set "INCLUDE=%INCLUDE%" & set "LIB=%LIB%" & set "LIBPATH=%LIBPATH%" & set "VSCMD_ARG_TGT_ARCH=%VSCMD_ARG_TGT_ARCH%"
%*
