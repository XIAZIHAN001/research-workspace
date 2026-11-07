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
using System.Globalization;
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
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int informationClass, IntPtr buffer, uint size, out uint required);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
  [StructLayout(LayoutKind.Sequential)] struct WindowRect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll", SetLastError=true)] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll", SetLastError=true)] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll", SetLastError=true)] static extern bool GetWindowRect(IntPtr window, out WindowRect rectangle);
  // Only fixed classifications and numeric API results may leave these process/window helpers.
  public class ProcessOutcome {
    public string result = "failed", phase = "open", identity = "unavailable", exitState = "unavailable";
    public int win32Error = 0;
    public ImageFailureExit imageFailureExit = null;
  }
  public class ImageFailureExit {
    public string creationTime = "unavailable", exitState = "unavailable";
    public int? timeError = null, waitError = null;
  }
  public class TokenOutcome : ProcessOutcome { public bool? elevation = null; public string integrity = "unavailable"; }
  public class DebugFlags {
    public string processType = "browser-candidate", port = "absent", address = "absent";
    public int portCount, addressCount;
    public bool pipe;
  }
  public class DebugOutcome : ProcessOutcome { public DebugFlags flags = null; }
  public class DiagnosticSelfTest { public bool passed; public int cases; }
  public class WindowCounts { public int total, visible, minimized, withArea; }
  public class WindowOutcome : ProcessOutcome { public WindowCounts windows = null; }
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
  static bool TryCreationTime(string expectedStart, out long fileTime) {
    fileTime = 0;
    DateTime parsed;
    if (expectedStart == null || expectedStart.Length != 28 || !DateTime.TryParseExact(expectedStart,
        "yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture,
        DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out parsed)) return false;
    try { fileTime = parsed.ToFileTimeUtc(); return true; } catch (ArgumentOutOfRangeException) { return false; }
  }
  static string CompareCreationTime(long created, string expectedStart) {
    long expected;
    return !TryCreationTime(expectedStart, out expected) ? "unavailable" : created == expected ? "matched" : "mismatch";
  }
  static bool ExitOnlyProven(ImageFailureExit evidence) {
    return evidence != null && evidence.creationTime == "matched" && evidence.timeError == 0 &&
      evidence.exitState == "signaled" && evidence.waitError == 0;
  }
  static void InspectImageFailureExit(IntPtr handle, string expectedStart, ProcessOutcome outcome) {
    // Preserve the original image-query phase/error. This lesser proof can only establish exit, never authorize a stop.
    var evidence = new ImageFailureExit();
    outcome.imageFailureExit = evidence;
    long created, exited, kernel, user;
    if (GetProcessTimes(handle, out created, out exited, out kernel, out user)) {
      evidence.timeError = 0; evidence.creationTime = CompareCreationTime(created, expectedStart);
    } else { evidence.timeError = Marshal.GetLastWin32Error(); }
    uint state = WaitForSingleObject(handle, 0);
    if (state == 0xFFFFFFFFu) { evidence.waitError = Marshal.GetLastWin32Error(); }
    else if (state == 0 || state == 258) {
      evidence.waitError = 0; evidence.exitState = state == 0 ? "signaled" : "nonsignaled";
    }
    if (ExitOnlyProven(evidence)) {
      outcome.result = "exited"; outcome.identity = "creation-time"; outcome.exitState = "signaled";
    }
  }
  // Open once and verify/observe/terminate through that handle: PID reuse cannot target a stranger.
  static bool OpenOwned(int pid, string expectedPath, string expectedStart, bool stop, ProcessOutcome outcome, out IntPtr handle) {
    // QUERY_LIMITED_INFORMATION + SYNCHRONIZE; read-only observation never requests TERMINATE.
    handle = OpenProcess(0x00101000u | (stop ? 0x0001u : 0u), false, pid);
    if (handle == IntPtr.Zero) {
      int error = Marshal.GetLastWin32Error();
      outcome.win32Error = error;
      if (error == 87) { outcome.result = "absent"; outcome.exitState = "absent"; }
      return false;
    }
    int length = 32768; var path = new StringBuilder(length);
    outcome.phase = "query-image";
    if (!QueryFullProcessImageName(handle, 0, path, ref length)) {
      int error = Marshal.GetLastWin32Error();
      outcome.win32Error = error;
      InspectImageFailureExit(handle, expectedStart, outcome);
      // Always false, including proven exit: this branch must never reach TerminateProcess.
      return false;
    }
    long created, exited, kernel, user;
    outcome.phase = "query-time";
    if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) {
      int error = Marshal.GetLastWin32Error();
      outcome.win32Error = error;
      return false;
    }
    outcome.phase = "identity";
    if (!String.Equals(path.ToString(), expectedPath, StringComparison.OrdinalIgnoreCase) || CompareCreationTime(created, expectedStart) != "matched") {
      outcome.result = "mismatch"; outcome.identity = "mismatch";
      return false;
    }
    outcome.identity = "matched";
    return true;
  }
  static bool ObserveExit(IntPtr handle, ProcessOutcome outcome, string phase, uint milliseconds) {
    outcome.phase = phase;
    uint state = WaitForSingleObject(handle, milliseconds);
    if (state == 0xFFFFFFFFu) {
      int error = Marshal.GetLastWin32Error();
      outcome.win32Error = error; outcome.exitState = "unavailable";
      return false;
    }
    outcome.exitState = state == 0 ? "signaled" : state == 258 ? "nonsignaled" : "unavailable";
    return outcome.exitState != "unavailable";
  }
  public static ProcessOutcome CheckOrStopOwned(int pid, string expectedPath, string expectedStart, bool stop) {
    var outcome = new ProcessOutcome();
    IntPtr handle = IntPtr.Zero;
    try {
      if (!OpenOwned(pid, expectedPath, expectedStart, stop, outcome, out handle)) return outcome;
      if (!ObserveExit(handle, outcome, "wait-before", 0)) return outcome;
      if (outcome.exitState == "signaled") { outcome.result = "exited"; return outcome; }
      if (!stop) { outcome.result = "matched"; outcome.phase = "complete"; return outcome; }
      if (!TerminateProcess(handle, 1)) {
        int error = Marshal.GetLastWin32Error();
        // Error 5 alone does not prove exit. Recheck this same verified handle, preserving the error.
        ObserveExit(handle, outcome, "terminate", 0);
        outcome.win32Error = error;
        if (outcome.exitState == "signaled") outcome.result = "exited";
        return outcome;
      }
      if (!ObserveExit(handle, outcome, "wait-after", 2000)) return outcome;
      if (outcome.exitState == "signaled") outcome.result = "stopped";
      return outcome;
    } finally { if (handle != IntPtr.Zero) CloseHandle(handle); }
  }
  static bool ExpectedImage(string path, string name) {
    return !String.IsNullOrEmpty(path) && path.Length <= 32768 && System.IO.Path.IsPathRooted(path) &&
      String.Equals(System.IO.Path.GetFileName(path), name, StringComparison.OrdinalIgnoreCase);
  }
  static string ClassifyIntegrity(uint rid) {
    switch (rid) {
      case 0x0000: return "untrusted";
      case 0x1000: return "low";
      case 0x2000: return "medium";
      case 0x2100: return "medium-plus";
      case 0x3000: return "high";
      case 0x4000: return "system";
      case 0x5000: return "protected";
      default: return "other";
    }
  }
  static bool ReadIntegrity(IntPtr buffer, uint size, out string integrity) {
    integrity = "unavailable";
    // TOKEN_MANDATORY_LABEL contains SID_AND_ATTRIBUTES. Validate every SID byte against the returned buffer.
    if (size < (uint)(IntPtr.Size * 2)) return false;
    IntPtr sid = Marshal.ReadIntPtr(buffer);
    ulong start = unchecked((ulong)buffer.ToInt64()), pointer = unchecked((ulong)sid.ToInt64());
    if (pointer < start || pointer - start > size || size - (pointer - start) < 12) return false;
    // Integrity labels use the canonical S-1-16-RID SID. The SID itself is never returned.
    if (Marshal.ReadByte(sid, 0) != 1 || Marshal.ReadByte(sid, 1) != 1) return false;
    for (int index = 2; index < 7; index++) if (Marshal.ReadByte(sid, index) != 0) return false;
    if (Marshal.ReadByte(sid, 7) != 16) return false;
    integrity = ClassifyIntegrity(unchecked((uint)Marshal.ReadInt32(sid, 8)));
    return true;
  }
  public static TokenOutcome InspectToken(int pid, string expectedPath, string expectedStart) {
    var outcome = new TokenOutcome(); outcome.result = "unavailable";
    IntPtr handle = IntPtr.Zero, token = IntPtr.Zero, buffer = IntPtr.Zero;
    try {
      if (pid <= 0 || !ExpectedImage(expectedPath, "research-workspace.exe")) {
        outcome.phase = "identity"; outcome.win32Error = 87; return outcome;
      }
      if (!OpenOwned(pid, expectedPath, expectedStart, false, outcome, out handle)) {
        outcome.result = "unavailable"; return outcome;
      }
      if (!ObserveExit(handle, outcome, "wait-before", 0) || outcome.exitState != "nonsignaled") return outcome;
      outcome.phase = "token-open";
      if (!OpenProcessToken(handle, 0x0008u, out token)) {
        outcome.win32Error = Marshal.GetLastWin32Error(); return outcome;
      }
      outcome.phase = "token-elevation";
      uint required;
      buffer = Marshal.AllocHGlobal(4);
      if (!GetTokenInformation(token, 20, buffer, 4, out required)) {
        outcome.win32Error = Marshal.GetLastWin32Error(); return outcome;
      }
      if (required != 4) { outcome.win32Error = 13; return outcome; }
      int elevated = Marshal.ReadInt32(buffer);
      if (elevated != 0 && elevated != 1) { outcome.win32Error = 13; return outcome; }
      Marshal.FreeHGlobal(buffer); buffer = IntPtr.Zero;
      outcome.phase = "token-integrity";
      bool sized = GetTokenInformation(token, 25, IntPtr.Zero, 0, out required);
      int sizeError = Marshal.GetLastWin32Error();
      if (sized || sizeError != 122) { outcome.win32Error = sized ? 13 : sizeError; return outcome; }
      if (required < (uint)(IntPtr.Size * 2) || required > 4096) { outcome.win32Error = 13; return outcome; }
      uint capacity = required;
      buffer = Marshal.AllocHGlobal((int)capacity);
      if (!GetTokenInformation(token, 25, buffer, capacity, out required)) {
        outcome.win32Error = Marshal.GetLastWin32Error(); return outcome;
      }
      string integrity;
      if (required > capacity || !ReadIntegrity(buffer, required, out integrity)) { outcome.win32Error = 13; return outcome; }
      if (!ObserveExit(handle, outcome, "wait-token-after", 0) || outcome.exitState != "nonsignaled") return outcome;
      outcome.result = "observed"; outcome.phase = "complete";
      outcome.elevation = elevated != 0; outcome.integrity = integrity;
      return outcome;
    } catch {
      outcome.result = "unavailable"; outcome.elevation = null; outcome.integrity = "unavailable";
      outcome.win32Error = 13; return outcome;
    } finally {
      if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
      if (token != IntPtr.Zero) CloseHandle(token);
      if (handle != IntPtr.Zero) CloseHandle(handle);
    }
  }
  static bool SwitchValue(string argument, string name, out string value) {
    value = null;
    if (argument == name) { value = ""; return true; }
    if (!argument.StartsWith(name + "=", StringComparison.Ordinal)) return false;
    value = argument.Substring(name.Length + 1); return true;
  }
  static string NormalizeWindowsSwitch(string argument) {
    // Chromium's Windows switch names are case-insensitive and accept --, - and /. Values retain their exact characters.
    int prefix = argument.StartsWith("--", StringComparison.Ordinal) ? 2 :
      argument.StartsWith("-", StringComparison.Ordinal) || argument.StartsWith("/", StringComparison.Ordinal) ? 1 : 0;
    if (prefix == 0) return null;
    int equals = argument.IndexOf('=', prefix);
    int end = equals < 0 ? argument.Length : equals;
    return "--" + argument.Substring(prefix, end - prefix).ToLowerInvariant() + (equals < 0 ? "" : argument.Substring(equals));
  }
  static bool PortNumber(string value, out int port) {
    port = 0;
    if (String.IsNullOrEmpty(value) || value.Length > 32768) return false;
    for (int index = 0; index < value.Length; index++) {
      if (value[index] < '0' || value[index] > '9') return false;
      int digit = value[index] - '0';
      if (port > (65535 - digit) / 10) return false;
      port = port * 10 + digit;
    }
    return port >= 1 && port <= 65535;
  }
  static DebugFlags ClassifyArguments(string[] arguments, int expectedPort) {
    var flags = new DebugFlags(); int typeCount = 0;
    // argv[0] is the executable, not a switch. Quoted text within another argument never becomes a switch.
    for (int index = 1; index < arguments.Length; index++) {
      string argument = arguments[index], value;
      if (argument == "--") break;
      argument = NormalizeWindowsSwitch(argument);
      if (argument == null) continue;
      if (SwitchValue(argument, "--remote-debugging-port", out value)) {
        flags.portCount++;
        int port;
        flags.port = flags.portCount > 1 ? "duplicate" : !PortNumber(value, out port) ? "invalid" : port == expectedPort ? "expected" : "different";
      } else if (SwitchValue(argument, "--remote-debugging-address", out value)) {
        flags.addressCount++;
        flags.address = flags.addressCount > 1 ? "duplicate" : String.IsNullOrWhiteSpace(value) ? "invalid" :
          value == "127.0.0.1" || String.Equals(value, "localhost", StringComparison.OrdinalIgnoreCase) || value == "::1" || value == "[::1]" ? "loopback" : "different";
      } else if (SwitchValue(argument, "--remote-debugging-pipe", out value)) {
        flags.pipe = true;
      } else if (SwitchValue(argument, "--type", out value)) {
        typeCount++;
        flags.processType = typeCount > 1 ? "other" :
          value == "renderer" || value == "gpu-process" || value == "utility" || value == "crashpad-handler" ? value : "other";
      }
    }
    return flags;
  }
  static bool ParseDebugFlags(string commandLine, int expectedPort, out DebugFlags flags, out int error) {
    flags = null; error = 13;
    if (String.IsNullOrWhiteSpace(commandLine) || commandLine.Length > 32768 || commandLine.IndexOf('\0') >= 0 || expectedPort < 1 || expectedPort > 65535) return false;
    IntPtr argv = IntPtr.Zero;
    try {
      int count;
      argv = CommandLineToArgvW(commandLine, out count);
      if (argv == IntPtr.Zero) { error = Marshal.GetLastWin32Error(); return false; }
      if (count < 1 || count > 4096) return false;
      var arguments = new string[count];
      for (int index = 0; index < count; index++) {
        IntPtr pointer = Marshal.ReadIntPtr(argv, index * IntPtr.Size);
        if (pointer == IntPtr.Zero) return false;
        arguments[index] = Marshal.PtrToStringUni(pointer);
        if (arguments[index] == null || arguments[index].Length > 32768) return false;
      }
      if (String.IsNullOrWhiteSpace(arguments[0])) return false;
      flags = ClassifyArguments(arguments, expectedPort); error = 0; return true;
    } catch { error = 13; return false; }
    finally { if (argv != IntPtr.Zero) LocalFree(argv); }
  }
  public static DebugOutcome InspectDebugFlags(int pid, string expectedPath, string expectedStart, int expectedPort, Func<int, string> readCommandLine) {
    var outcome = new DebugOutcome(); outcome.result = "unavailable";
    IntPtr handle = IntPtr.Zero;
    try {
      if (pid <= 0 || !ExpectedImage(expectedPath, "msedgewebview2.exe") || expectedPort < 1 || expectedPort > 65535) {
        outcome.phase = "identity"; outcome.win32Error = 87; return outcome;
      }
      if (!OpenOwned(pid, expectedPath, expectedStart, false, outcome, out handle)) {
        outcome.result = "unavailable"; return outcome;
      }
      if (!ObserveExit(handle, outcome, "wait-before", 0) || outcome.exitState != "nonsignaled") return outcome;
      outcome.phase = "command-line";
      // The callback performs one targeted PID query while this identity-matched process handle remains open.
      string commandLine = readCommandLine == null ? null : readCommandLine(pid);
      if (String.IsNullOrWhiteSpace(commandLine)) return outcome;
      outcome.phase = "parse-arguments";
      DebugFlags flags; int error;
      if (!ParseDebugFlags(commandLine, expectedPort, out flags, out error)) { outcome.win32Error = error; return outcome; }
      if (!ObserveExit(handle, outcome, "wait-arguments-after", 0) || outcome.exitState != "nonsignaled") return outcome;
      outcome.result = "observed"; outcome.phase = "complete"; outcome.flags = flags;
      return outcome;
    } catch {
      outcome.result = "unavailable"; outcome.flags = null; outcome.win32Error = 13; return outcome;
    } finally { if (handle != IntPtr.Zero) CloseHandle(handle); }
  }
  static void AssertDiagnostic(DiagnosticSelfTest test, bool condition) {
    if (!condition) throw new InvalidOperationException("DIAGNOSTIC_SELF_TEST_FAILED");
    test.cases++;
  }
  static void CheckFlagsFixture(DiagnosticSelfTest test, string commandLine, string port, int portCount,
      string address, int addressCount, string processType, bool pipe) {
    DebugFlags flags; int error;
    AssertDiagnostic(test, ParseDebugFlags(commandLine, 9222, out flags, out error) && error == 0 &&
      flags.port == port && flags.portCount == portCount && flags.address == address &&
      flags.addressCount == addressCount && flags.processType == processType && flags.pipe == pipe);
  }
  public static DiagnosticSelfTest SelfTestDiagnostics(Func<object, string> serialize) {
    // Synthetic inputs only. Exercise the production parser/classifiers, without opening or stopping any process.
    var test = new DiagnosticSelfTest();
    try {
      const string executable = "\"C:\\synthetic fixture\\msedgewebview2.exe\" ";
      CheckFlagsFixture(test, executable + "--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1", "expected", 1, "loopback", 1, "browser-candidate", false);
      CheckFlagsFixture(test, executable + "\"--foo=--remote-debugging-port=9222\" \"quoted --remote-debugging-address=localhost\"", "absent", 0, "absent", 0, "browser-candidate", false);
      CheckFlagsFixture(test, executable + "\"--remote-debugging-port=9222\"", "expected", 1, "absent", 0, "browser-candidate", false);
      CheckFlagsFixture(test, executable + "--remote-debugging-port=9222 --remote-debugging-port=9222", "duplicate", 2, "absent", 0, "browser-candidate", false);
      CheckFlagsFixture(test, executable + "--remote-debugging-port=9222 --remote-debugging-port=9333", "duplicate", 2, "absent", 0, "browser-candidate", false);
      CheckFlagsFixture(test, executable + "-- --remote-debugging-port=9222 --remote-debugging-address=localhost --type=renderer --remote-debugging-pipe", "absent", 0, "absent", 0, "browser-candidate", false);
      CheckFlagsFixture(test, executable + "--remote-debugging-port=9333", "different", 1, "absent", 0, "browser-candidate", false);
      foreach (string value in new string[] { "", "=", "=abc", "=0", "=65536", "=-1", "=99999999999999999999" })
        CheckFlagsFixture(test, executable + "--remote-debugging-port" + value, "invalid", 1, "absent", 0, "browser-candidate", false);
      CheckFlagsFixture(test, executable + "\"--remote-debugging-port=9 222\"", "invalid", 1, "absent", 0, "browser-candidate", false);
      CheckFlagsFixture(test, executable + "--remote-debugging-port=0009222", "expected", 1, "absent", 0, "browser-candidate", false);
      CheckFlagsFixture(test, executable + "--remote-debugging-port=invalid --remote-debugging-port=9222", "duplicate", 2, "absent", 0, "browser-candidate", false);
      foreach (string address in new string[] { "localhost", "LOCALHOST", "::1", "[::1]" })
        CheckFlagsFixture(test, executable + "--remote-debugging-address=" + address, "absent", 0, "loopback", 1, "browser-candidate", false);
      CheckFlagsFixture(test, executable + "--remote-debugging-address=0.0.0.0", "absent", 0, "different", 1, "browser-candidate", false);
      CheckFlagsFixture(test, executable + "--remote-debugging-address", "absent", 0, "invalid", 1, "browser-candidate", false);
      CheckFlagsFixture(test, executable + "--remote-debugging-address=", "absent", 0, "invalid", 1, "browser-candidate", false);
      CheckFlagsFixture(test, executable + "--remote-debugging-address=localhost --remote-debugging-address=localhost", "absent", 0, "duplicate", 2, "browser-candidate", false);
      CheckFlagsFixture(test, executable + "--remote-debugging-address=localhost --remote-debugging-address=0.0.0.0", "absent", 0, "duplicate", 2, "browser-candidate", false);
      CheckFlagsFixture(test, executable + "--remote-debugging-pipe", "absent", 0, "absent", 0, "browser-candidate", true);
      CheckFlagsFixture(test, executable + "--remote-debugging-pipe=", "absent", 0, "absent", 0, "browser-candidate", true);
      foreach (string type in new string[] { "renderer", "gpu-process", "utility", "crashpad-handler" })
        CheckFlagsFixture(test, executable + "--type=" + type, "absent", 0, "absent", 0, type, false);
      foreach (string type in new string[] { "unknown", "", "renderer --type=renderer" })
        CheckFlagsFixture(test, executable + "--type=" + type, "absent", 0, "absent", 0, "other", false);
      CheckFlagsFixture(test, executable + "--foo=--type=renderer", "absent", 0, "absent", 0, "browser-candidate", false);
      CheckFlagsFixture(test, executable + "-remote-debugging-port=9222 /remote-debugging-address=localhost", "expected", 1, "loopback", 1, "browser-candidate", false);
      CheckFlagsFixture(test, executable + "--REMOTE-DEBUGGING-PORT=9222 /TYPE=renderer -REMOTE-DEBUGGING-PIPE", "expected", 1, "absent", 0, "renderer", true);
      CheckFlagsFixture(test, executable + "--remote-debugging-port=9222 /REMOTE-DEBUGGING-PORT=9333", "duplicate", 2, "absent", 0, "browser-candidate", false);
      CheckFlagsFixture(test, executable + "-- /REMOTE-DEBUGGING-PORT=9222 -REMOTE-DEBUGGING-PIPE", "absent", 0, "absent", 0, "browser-candidate", false);
      DebugFlags flags; int error;
      var tooManyArguments = new StringBuilder("app");
      for (int index = 0; index < 4096; index++) tooManyArguments.Append(" x");
      foreach (string unreadable in new string[] { null, "", "  ", "app\0--remote-debugging-port=9222", new string('x', 32769), tooManyArguments.ToString() })
        AssertDiagnostic(test, !ParseDebugFlags(unreadable, 9222, out flags, out error) && flags == null);
      AssertDiagnostic(test, !ParseDebugFlags(executable, 0, out flags, out error) && flags == null);
      AssertDiagnostic(test, !ParseDebugFlags(executable, 65536, out flags, out error) && flags == null);
      const string exact = "2026-11-06T12:34:56.1234567Z";
      long created;
      AssertDiagnostic(test, TryCreationTime(exact, out created) && CompareCreationTime(created, exact) == "matched");
      AssertDiagnostic(test, CompareCreationTime(created, "2026-11-06T12:34:56.1234568Z") == "mismatch");
      AssertDiagnostic(test, CompareCreationTime(created, "2026-11-06T12:34:56.1234566Z") == "mismatch");
      foreach (string invalid in new string[] { null, "2026-11-06T12:34:56.123Z", "2026-11-06T12:34:56.1234567+00:00", "invalid" })
        AssertDiagnostic(test, CompareCreationTime(created, invalid) == "unavailable");
      AssertDiagnostic(test, ExitOnlyProven(new ImageFailureExit { creationTime = "matched", timeError = 0, exitState = "signaled", waitError = 0 }));
      foreach (string creation in new string[] { "mismatch", "unavailable" })
        AssertDiagnostic(test, !ExitOnlyProven(new ImageFailureExit { creationTime = creation, timeError = 0, exitState = "signaled", waitError = 0 }));
      foreach (int? failed in new int?[] { null, 5 }) {
        AssertDiagnostic(test, !ExitOnlyProven(new ImageFailureExit { creationTime = "matched", timeError = failed, exitState = "signaled", waitError = 0 }));
        AssertDiagnostic(test, !ExitOnlyProven(new ImageFailureExit { creationTime = "matched", timeError = 0, exitState = "signaled", waitError = failed }));
      }
      foreach (string state in new string[] { "nonsignaled", "unavailable" })
        AssertDiagnostic(test, !ExitOnlyProven(new ImageFailureExit { creationTime = "matched", timeError = 0, exitState = state, waitError = 0 }));
      AssertDiagnostic(test, !ExitOnlyProven(null));
      uint[] rids = new uint[] { 0, 0x1000, 0x2000, 0x2100, 0x3000, 0x4000, 0x5000, 0x7777 };
      string[] integrity = new string[] { "untrusted", "low", "medium", "medium-plus", "high", "system", "protected", "other" };
      for (int index = 0; index < rids.Length; index++) AssertDiagnostic(test, ClassifyIntegrity(rids[index]) == integrity[index]);
      const string canary = "RW_NATIVE_DIAGNOSTIC_CANARY_7c2e";
      AssertDiagnostic(test, ParseDebugFlags("\"C:\\" + canary + "\\msedgewebview2.exe\" --user-data-dir=\"" + canary + "\" --foo=--remote-debugging-port=42 --remote-debugging-port=9222 --remote-debugging-address=" + canary,
        9222, out flags, out error) && flags.port == "expected" && flags.address == "different");
      var diagnostic = new DebugOutcome { result = "observed", phase = "complete", identity = "matched", exitState = "nonsignaled", flags = flags };
      string json = serialize == null ? null : serialize(diagnostic);
      AssertDiagnostic(test, json != null && json.Contains("\"flags\"") && json.Contains("\"expected\"") && !json.Contains(canary) && !json.Contains("--remote-debugging"));
      test.passed = true;
    } catch { test.passed = false; }
    return test;
  }
  public static WindowOutcome InspectWindow(int pid, string expectedPath, string expectedStart) {
    var outcome = new WindowOutcome();
    outcome.result = "unavailable";
    IntPtr handle = IntPtr.Zero;
    try {
      if (!OpenOwned(pid, expectedPath, expectedStart, false, outcome, out handle)) {
        outcome.result = "unavailable";
        return outcome;
      }
      if (!ObserveExit(handle, outcome, "wait-before", 0) || outcome.exitState != "nonsignaled") return outcome;
      int total = 0, visible = 0, minimized = 0, area = 0;
      bool callbackFailed = false;
      EnumWindowsProc inspect = delegate(IntPtr window, IntPtr parameter) {
        uint owner;
        if (GetWindowThreadProcessId(window, out owner) == 0) {
          int error = Marshal.GetLastWin32Error();
          outcome.phase = "window-process"; outcome.win32Error = error; callbackFailed = true;
          return false;
        }
        if (owner != (uint)pid) return true;
        bool isVisible = IsWindowVisible(window), isMinimized = IsIconic(window);
        WindowRect rectangle;
        if (!GetWindowRect(window, out rectangle)) {
          int error = Marshal.GetLastWin32Error();
          outcome.phase = "window-rect"; outcome.win32Error = error; callbackFailed = true;
          return false;
        }
        // Window handles can be reused too. Never count one that changed owner during observation.
        if (GetWindowThreadProcessId(window, out owner) == 0) {
          int error = Marshal.GetLastWin32Error();
          outcome.phase = "window-process"; outcome.win32Error = error; callbackFailed = true;
          return false;
        }
        if (owner != (uint)pid) { outcome.phase = "window-process"; callbackFailed = true; return false; }
        total++;
        if (isVisible) visible++;
        if (isMinimized) minimized++;
        if (rectangle.Right > rectangle.Left && rectangle.Bottom > rectangle.Top) area++;
        return true;
      };
      if (!EnumWindows(inspect, IntPtr.Zero)) {
        int error = Marshal.GetLastWin32Error();
        if (!callbackFailed) { outcome.phase = "enum-windows"; outcome.win32Error = error; }
        return outcome;
      }
      // Holding the verified process handle through enumeration prevents PID reuse; require it alive.
      if (!ObserveExit(handle, outcome, "wait-window-after", 0) || outcome.exitState != "nonsignaled") return outcome;
      outcome.result = "observed"; outcome.phase = "complete";
      outcome.windows = new WindowCounts { total = total, visible = visible, minimized = minimized, withArea = area };
      return outcome;
    } finally { if (handle != IntPtr.Zero) CloseHandle(handle); }
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
      $rows = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, ExecutablePath | ForEach-Object {
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
      [RuntimeAcceptanceNative]::CheckOrStopOwned([int]$request.process.pid, $request.process.path, $start, ($request.action -eq 'stop')) | ConvertTo-Json -Depth 6 -Compress
    }
    'inspect-window' {
      $start = ([DateTime]$request.process.startedAt).ToUniversalTime().ToString('o')
      [RuntimeAcceptanceNative]::InspectWindow([int]$request.process.pid, $request.process.path, $start) | ConvertTo-Json -Compress
    }
    'inspect-token' {
      $start = ([DateTime]$request.process.startedAt).ToUniversalTime().ToString('o')
      [RuntimeAcceptanceNative]::InspectToken([int]$request.process.pid, $request.process.path, $start) | ConvertTo-Json -Depth 6 -Compress
    }
    'inspect-debug-flags' {
      if ($request.processes -isnot [Array] -or $request.processes.Count -gt 32 -or
          ($request.expectedPort -isnot [int] -and $request.expectedPort -isnot [long]) -or
          $request.expectedPort -lt 1 -or $request.expectedPort -gt 65535) { throw 'DEBUG_REQUEST_INVALID' }
      $readCommandLine = [Func[int, string]] {
        param([int]$processId)
        # Never enumerate global command lines. This callback is invoked while C# holds the verified process handle.
        $rows = @(Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = {0}' -f $processId) -Property CommandLine -OperationTimeoutSec 2 -ErrorAction Stop)
        if ($rows.Count -ne 1 -or $rows[0].CommandLine -isnot [string]) { return $null }
        return $rows[0].CommandLine
      }
      $outcomes = @(
        foreach ($ownedProcess in $request.processes) {
          $start = ([DateTime]$ownedProcess.startedAt).ToUniversalTime().ToString('o')
          [RuntimeAcceptanceNative]::InspectDebugFlags([int]$ownedProcess.pid, $ownedProcess.path, $start, [int]$request.expectedPort, $readCommandLine)
        }
      )
      ConvertTo-Json -InputObject $outcomes -Depth 6 -Compress
    }
    'self-test-diagnostics' {
      $serialize = [Func[object, string]] { param($value) ConvertTo-Json -InputObject $value -Depth 6 -Compress }
      [RuntimeAcceptanceNative]::SelfTestDiagnostics($serialize) | ConvertTo-Json -Compress
    }
    'observe-owned' {
      $outcomes = @(
        foreach ($ownedProcess in $request.processes) {
          $start = ([DateTime]$ownedProcess.startedAt).ToUniversalTime().ToString('o')
          [RuntimeAcceptanceNative]::CheckOrStopOwned([int]$ownedProcess.pid, $ownedProcess.path, $start, $false)
        }
      )
      ConvertTo-Json -InputObject $outcomes -Depth 6 -Compress
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
