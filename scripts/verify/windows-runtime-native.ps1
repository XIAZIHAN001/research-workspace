# Narrow bridge for windows-runtime.mjs. JSON stdin only; never print arguments, secrets or blobs.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows' -or $env:RW_WINDOWS_FRESH_RUNNER -ne 'yes') { throw 'HOSTED_RUNNER_REQUIRED' }
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
public static class RuntimeAcceptanceNative {
  [StructLayout(LayoutKind.Sequential)] struct Credential {
    public uint Flags, Type; public IntPtr TargetName, Comment; public long LastWritten;
    public uint BlobSize; public IntPtr Blob; public uint Persist, AttributeCount;
    public IntPtr Attributes, TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredEnumerateW(string filter, uint flags, out uint count, out IntPtr values);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredReadW(string target, uint type, uint flags, out IntPtr value);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredDeleteW(string target, uint type, uint flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr value);
  [DllImport("shell32.dll")] static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static string KnownFolder(string id) {
    Guid guid = new Guid(id); IntPtr value;
    int result = SHGetKnownFolderPath(ref guid, 0, IntPtr.Zero, out value);
    if (result != 0) throw new InvalidOperationException("KNOWN_FOLDER_UNAVAILABLE");
    try { return Marshal.PtrToStringUni(value); } finally { Marshal.FreeCoTaskMem(value); }
  }
  public static bool DesktopAvailable() {
    IntPtr desktop = OpenInputDesktop(0, false, 1);
    if (desktop == IntPtr.Zero) return false;
    CloseDesktop(desktop); return Environment.UserInteractive;
  }
  public static string[] AppTargets() {
    uint count; IntPtr values;
    if (!CredEnumerateW(null, 0, out count, out values)) {
      if (Marshal.GetLastWin32Error() == 1168) return new string[0];
      throw new InvalidOperationException("CREDENTIAL_ENUMERATION_FAILED");
    }
    var targets = new List<string>();
    try {
      for (int i = 0; i < count; i++) {
        var value = (Credential)Marshal.PtrToStructure(Marshal.ReadIntPtr(values, i * IntPtr.Size), typeof(Credential));
        string target = Marshal.PtrToStringUni(value.TargetName);
        if (target != null && target.StartsWith("ResearchWorkspace", StringComparison.OrdinalIgnoreCase)) targets.Add(target);
      }
    } finally { CredFree(values); }
    return targets.ToArray();
  }
  public static string OwnedCredential(string target, string expectedHash, bool delete) {
    if (!System.Text.RegularExpressions.Regex.IsMatch(target, @"^ResearchWorkspace/Provider/(deepseek|openai|moonshot|zhipu|dashscope|custom)$")) throw new InvalidOperationException("TARGET_REFUSED");
    if (!System.Text.RegularExpressions.Regex.IsMatch(expectedHash, @"^[a-f0-9]{64}$")) throw new InvalidOperationException("PROOF_REQUIRED");
    IntPtr raw;
    if (!CredReadW(target, 1, 0, out raw)) {
      if (Marshal.GetLastWin32Error() == 1168) return "absent";
      throw new InvalidOperationException("CREDENTIAL_READ_FAILED");
    }
    bool matches;
    try {
      var value = (Credential)Marshal.PtrToStructure(raw, typeof(Credential));
      if (value.BlobSize == 0 || value.BlobSize > 2560 || value.Blob == IntPtr.Zero) return "mismatch";
      byte[] bytes = new byte[value.BlobSize];
      try {
        Marshal.Copy(value.Blob, bytes, 0, bytes.Length);
        using (var sha = SHA256.Create()) {
          matches = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant() == expectedHash;
        }
      } finally { Array.Clear(bytes, 0, bytes.Length); }
    } finally { CredFree(raw); }
    if (!matches) return "mismatch";
    if (!delete) return "owned";
    if (!CredDeleteW(target, 1, 0)) throw new InvalidOperationException("CREDENTIAL_DELETE_FAILED");
    return "deleted";
  }
  // Open once and verify/terminate through that same handle: a PID reuse cannot kill a stranger.
  public static string CheckOrStopOwned(int pid, string expectedPath, string expectedStart, bool stop) {
    IntPtr handle = OpenProcess(0x1001, false, pid);
    if (handle == IntPtr.Zero) {
      if (Marshal.GetLastWin32Error() == 87) return "absent";
      throw new InvalidOperationException("PROCESS_HANDLE_UNAVAILABLE");
    }
    try {
      int length = 32768; var path = new StringBuilder(length);
      long created, exited, kernel, user;
      if (!QueryFullProcessImageName(handle, 0, path, ref length) || !GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw new InvalidOperationException("PROCESS_IDENTITY_UNAVAILABLE");
      if (!String.Equals(path.ToString(), expectedPath, StringComparison.OrdinalIgnoreCase) || DateTime.FromFileTimeUtc(created).ToString("o") != expectedStart) return "mismatch";
      if (!stop) return "matched";
      if (!TerminateProcess(handle, 1)) throw new InvalidOperationException("PROCESS_STOP_FAILED");
      return "stopped";
    } finally { CloseHandle(handle); }
  }
}
'@

  switch ($request.action) {
    'preflight' {
      $local = [RuntimeAcceptanceNative]::KnownFolder('F1B32785-6FBA-4FCF-9D55-7B8E7F157091')
      $roaming = [RuntimeAcceptanceNative]::KnownFolder('3EB685DB-65F9-4CF6-A03A-E3EF65729F3D')
      $roots = @($local, $roaming)
      $present = @()
      foreach ($root in $roots) {
        foreach ($name in @('com.researchworkspace.desktop', 'com.researchworkspace.desktop.dev', 'Research Workspace', 'ResearchWorkspace', 'research-workspace')) {
          if (Test-Path -LiteralPath (Join-Path $root $name)) { $present += $name }
        }
      }
      foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($root -and (Test-Path -LiteralPath (Join-Path $root 'Research Workspace'))) { $present += 'installed-app' }
      }
      $targets = [RuntimeAcceptanceNative]::AppTargets()
      $registered = 0
      foreach ($base in @('HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
        if (Test-Path $base) {
          foreach ($key in Get-ChildItem $base) {
            $value = Get-ItemProperty $key.PSPath
            if ($value.DisplayName -eq 'Research Workspace') { $registered++ }
          }
        }
      }
      $versions = @()
      foreach ($base in @('HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients', 'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients')) {
        if (Test-Path $base) {
          foreach ($key in Get-ChildItem $base) {
            $value = Get-ItemProperty $key.PSPath
            if ($value.name -like '*WebView2*' -and $value.pv -match '^\d+(\.\d+)+$') { $versions += $value.pv }
          }
        }
      }
      # No names/paths from existing user state leave this bridge.
      @{ existingDirectories = $present.Count; existingCredentials = $targets.Count; existingRegistrations = $registered; desktop = [RuntimeAcceptanceNative]::DesktopAvailable(); webviewVersions = @($versions | Select-Object -Unique) } | ConvertTo-Json -Compress
    }
    'snapshot' {
      $rows = @(Get-CimInstance Win32_Process | ForEach-Object {
        if ($_.ExecutablePath) {
          try {
            $process = Get-Process -Id $_.ProcessId -ErrorAction Stop
            @{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; path = $_.ExecutablePath; startedAt = $process.StartTime.ToUniversalTime().ToString('o') }
          } catch { } # Process exited during snapshot; never infer ownership from missing data.
        }
      })
      ConvertTo-Json -InputObject $rows -Compress
    }
    { $_ -in @('stop', 'verify-process') } {
      # ConvertFrom-Json may parse ISO timestamps to DateTime. Recreate the exact UTC round-trip form.
      $start = ([DateTime]$request.process.startedAt).ToUniversalTime().ToString('o')
      @{ result = [RuntimeAcceptanceNative]::CheckOrStopOwned([int]$request.process.pid, $request.process.path, $start, ($request.action -eq 'stop')) } | ConvertTo-Json -Compress
    }
    'credential' {
      @{ result = [RuntimeAcceptanceNative]::OwnedCredential($request.target, $request.expectedHash, [bool]$request.delete); remaining = [RuntimeAcceptanceNative]::AppTargets().Length } | ConvertTo-Json -Compress
    }
    'version' {
      @{ version = (Get-Item -LiteralPath $request.path).VersionInfo.ProductVersion } | ConvertTo-Json -Compress
    }
    default { throw 'UNKNOWN_NATIVE_ACTION' }
  }
} catch {
  # Never echo exception messages: native/tool errors can contain stdin or paths.
  [Console]::Error.WriteLine('WINDOWS_NATIVE_BRIDGE_FAILED')
  exit 1
}
