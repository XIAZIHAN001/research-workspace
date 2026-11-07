# Fixed probe/runtime modes plus read-only child verification. Never echo request or exception text.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows' -or $env:RW_WINDOWS_FRESH_RUNNER -ne 'yes') { throw 'HOSTED_RUNNER_REQUIRED' }
  $root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
  $phase = 'compilation'
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-bootstrap-native.cs'), (Join-Path $PSScriptRoot 'windows-bootstrap-native-tests.cs') -ErrorAction Stop
  $phase = 'input'
  if ($request.action -eq 'launch' -and $request.mode -in @('probe', 'runtime')) {
    $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    foreach ($property in $request.environment.PSObject.Properties) { $environment.Add($property.Name, [string]$property.Value) }
    $result = [WindowsBootstrapNative]::Run($root, [string]$request.nodePath, [string]$request.nodeSha256, [string]$request.mode, [string]$request.id, $environment)
  } elseif ($request.action -eq 'inspect') {
    $result = [WindowsBootstrapNative]::Inspect([uint32]$request.pid, [string]$request.nodePath, [string]$request.created100ns)
  } else { throw 'FIXED_ACTION_REQUIRED' }
  $result | ConvertTo-Json -Compress -Depth 8
} catch {
  # Compilation/runtime failures are explicit but never publish raw source/errors/environment.
  $compilerCode = $null
  if ($phase -eq 'compilation' -and $_.ToString() -match '\bCS[0-9]{4}\b') { $compilerCode = $Matches[0] }
  @{ status = 'FAIL'; phase = $(if ($phase -eq 'compilation') { 'compilation' } else { 'input' }); code = $(if ($phase -eq 'compilation') { 'NATIVE_COMPILE_FAILED' } else { 'NATIVE_FAILURE' }); compilerCode = $compilerCode; win32Error = 0 } | ConvertTo-Json -Compress
  exit 1
}
