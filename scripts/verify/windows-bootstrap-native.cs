using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

// Only this ephemeral, same-token SAFER route is supported. No fallback launch API.
public static class WindowsBootstrapNative {
  public const uint CreationFlags = 0x08080404; // NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | UNICODE_ENVIRONMENT | SUSPENDED
  public const long JobAttribute = 0x0002000d; // PROC_THREAD_ATTRIBUTE_JOB_LIST
  public const uint JobLimit = 0x00002000; // KILL_ON_JOB_CLOSE, and nothing else
  const uint QueryToken = 0x0008, DuplicateSource = 0x000b, LaunchToken = 0x008b;
  const uint WaitTimeout = 258, WaitFailed = 0xffffffff;
  public class GateFailure : Exception {
    public string Code; public int Error; public TokenFailureDetail TokenFailure;
    public GateFailure(string code, int error = 0) : base(code) { Code = code; Error = error; }
  }
  public class TokenFailureDetail { public string field, reason; }
  public class Outcome {
    public string status = "FAIL", phase = "input", code = "NATIVE_FAILURE";
    public int win32Error, nativeTests;
    public TokenFailureDetail tokenFailure;
    public bool candidateVerified, childVerified, atomicJob, noInheritedHandles, resumed, exited, cleanupVerified, forcedTermination;
    public uint? exitCode, activeProcesses;
  }
  public class ContextOutcome {
    public string status = "FAIL", phase = "input", code = "NATIVE_FAILURE";
    public int win32Error;
    public TokenFailureDetail tokenFailure;
    public bool ordinary, sameIdentity, exactCreation, imageMatched, jobMember, desktopAvailable;
  }
  public class TokenFacts {
    public string User, Authentication, Logon;
    public uint Session, Type, Integrity, Elevation, UIAccess, SandboxInert;
    public Dictionary<string,uint> Groups, Privileges;
  }
  [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; public override string ToString() { return High.ToString("x8") + Low.ToString("x8"); } }
  [StructLayout(LayoutKind.Sequential)] struct SidAttributes { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct FirstGroup { public uint Count; public SidAttributes First; }
  [StructLayout(LayoutKind.Sequential)] struct LuidAttributes { public Luid Luid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct TokenStatistics { public Luid TokenId, AuthenticationId; public long Expiration; public uint Type, Impersonation, DynamicCharged, DynamicAvailable, GroupCount, PrivilegeCount; public Luid ModifiedId; }
  [StructLayout(LayoutKind.Sequential)] struct StartupInfo {
    public int cb; public IntPtr reserved, desktop, title;
    public uint x, y, xSize, ySize, xChars, yChars, fill, flags;
    public ushort show, reservedSize; public IntPtr reservedBytes, stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo Startup; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr Process, Thread; public uint Pid, Tid; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long User, Kernel, PeriodUser, PeriodKernel; public uint Faults, Total, Active, Terminated; }

  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetHandleInformation(IntPtr handle, out uint flags);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int informationClass, IntPtr buffer, uint size, out uint required);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetTokenInformation(IntPtr token, int informationClass, IntPtr buffer, uint size);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr security, int impersonationLevel, int tokenType, out IntPtr result);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool SaferCreateLevel(uint scope, uint level, uint open, out IntPtr handle, IntPtr reserved);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool SaferComputeTokenFromLevel(IntPtr level, IntPtr input, out IntPtr output, uint flags, IntPtr reserved);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool SaferCloseLevel(IntPtr level);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr text);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSidToSidW(string text, out IntPtr sid);
  [DllImport("advapi32.dll")] static extern bool IsValidSid(IntPtr sid);
  [DllImport("advapi32.dll")] static extern uint GetLengthSid(IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool LookupPrivilegeNameW(string system, ref Luid luid, StringBuilder name, ref int length);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint size, out uint required);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inJob);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessAsUserW(IntPtr token, string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref int length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetProcessId(IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct ProcessEntry {
    public uint Size, Usage, Pid; public UIntPtr Heap; public uint Module, Threads, Parent;
    public int Priority; public uint Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string File;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);

  static void Need(bool value, string code) { if (!value) throw new GateFailure(code); }
  static void Api(bool value) { if (!value) throw new GateFailure("NATIVE_API_FAILED", Marshal.GetLastWin32Error()); }
  static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
  public static void NoInheritance(uint flags) { Need((flags & 1) == 0, "HANDLE_INHERITANCE_REFUSED"); }
  static void NonInherited(IntPtr handle) { uint flags; Api(GetHandleInformation(handle, out flags)); NoInheritance(flags); }
  public static bool SameCreation(long a, long b) { return a > 0 && a == b; }
  public static bool ExpectedResume(uint count) { return count == 1; }
  public static bool CleanupProven(bool exited, uint active) { return exited && active == 0; }
  static string TokenField(int kind) {
    switch (kind) {
      case 1: return "user"; case 2: return "groups"; case 3: return "privileges";
      case 8: return "type"; case 10: return "statistics"; case 12: return "session";
      case 15: return "sandbox"; case 20: return "elevation"; case 25: return "integrity";
      case 26: return "ui-access"; default: return "unavailable";
    }
  }
  static void TokenNeed(bool value, string field, string reason, int error = 0) {
    if (!value) throw new GateFailure("TOKEN_REJECTED", error) { TokenFailure = new TokenFailureDetail { field = field, reason = reason } };
  }
  static void TokenApi(bool value, string field, string reason) {
    if (!value) {
      int error = Marshal.GetLastWin32Error();
      throw new GateFailure("NATIVE_API_FAILED", error) { TokenFailure = new TokenFailureDetail { field = field, reason = reason } };
    }
  }
  // Same sizing predicate as before, split only to retain the failing clause and actual API error.
  public static void ValidateInfoSize(bool first, int error, uint length, int kind) {
    string field = TokenField(kind);
    TokenNeed(!first, field, "size-query-unexpected-success");
    TokenNeed(error == 122, field, "size-query-error", error);
    TokenNeed(length > 0 && length <= 1024 * 1024, field, "buffer-size");
  }
  static IntPtr Info(IntPtr token, int kind, out uint length) {
    length = 0;
    bool first = GetTokenInformation(token, kind, IntPtr.Zero, 0, out length);
    int error = Marshal.GetLastWin32Error();
    ValidateInfoSize(first, error, length, kind);
    IntPtr buffer = Marshal.AllocHGlobal((int)length);
    try { TokenApi(GetTokenInformation(token, kind, buffer, length, out length), TokenField(kind), "read-query-error"); return buffer; }
    catch { Marshal.FreeHGlobal(buffer); throw; }
  }
  public delegate bool FixedScalarQuery(int kind, IntPtr buffer, uint capacity, out uint length, out int error);
  public static uint ReadScalar(int kind, FixedScalarQuery query) {
    // TOKEN_TYPE, session/SandboxInert/UIAccess DWORDs and one-DWORD TOKEN_ELEVATION only.
    // https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_information_class
    TokenNeed(kind == 8 || kind == 12 || kind == 15 || kind == 20 || kind == 26, TokenField(kind), "scalar-class");
    IntPtr value = Marshal.AllocHGlobal(4);
    try {
      uint length; int error;
      if (!query(kind, value, 4, out length, out error))
        throw new GateFailure("NATIVE_API_FAILED", error) { TokenFailure = new TokenFailureDetail { field = TokenField(kind), reason = "read-query-error" } };
      TokenNeed(length == 4, TokenField(kind), "scalar-size");
      return unchecked((uint)Marshal.ReadInt32(value));
    } finally { Marshal.FreeHGlobal(value); }
  }
  static uint Scalar(IntPtr token, int kind) {
    // No NULL/zero sizing probe and no retry: fixed-size classes have a documented four-byte buffer.
    return ReadScalar(kind, (int requested, IntPtr buffer, uint capacity, out uint length, out int error) => {
      bool success = GetTokenInformation(token, requested, buffer, capacity, out length);
      error = success ? 0 : Marshal.GetLastWin32Error();
      return success;
    });
  }
  static string SidText(IntPtr sid, string field) {
    TokenNeed(sid != IntPtr.Zero && IsValidSid(sid), field, "sid-invalid");
    IntPtr text; TokenApi(ConvertSidToStringSidW(sid, out text), field, "sid-conversion-error");
    try { return Marshal.PtrToStringUni(text); } finally { LocalFree(text); }
  }
  static uint Integrity(IntPtr token) {
    uint length; IntPtr value = Info(token, 25, out length);
    try {
      var label = Marshal.PtrToStructure<SidAttributes>(value);
      TokenNeed((label.Attributes & 0x20) != 0, "integrity", "integrity-attribute");
      TokenNeed(SidText(label.Sid, "integrity").StartsWith("S-1-16-", StringComparison.Ordinal), "integrity", "integrity-sid-shape");
      byte count = Marshal.ReadByte(GetSidSubAuthorityCount(label.Sid));
      TokenNeed(count == 1, "integrity", "integrity-subauthorities");
      return unchecked((uint)Marshal.ReadInt32(GetSidSubAuthority(label.Sid, 0)));
    } finally { Marshal.FreeHGlobal(value); }
  }
  static TokenFacts Facts(IntPtr token) {
    var result = new TokenFacts { Groups = new Dictionary<string,uint>(StringComparer.Ordinal), Privileges = new Dictionary<string,uint>(StringComparer.Ordinal) };
    uint length; IntPtr buffer = Info(token, 1, out length);
    try { result.User = SidText(Marshal.ReadIntPtr(buffer), "user"); } finally { Marshal.FreeHGlobal(buffer); }
    buffer = Info(token, 10, out length);
    try {
      TokenNeed(length >= Marshal.SizeOf<TokenStatistics>(), "statistics", "statistics-size");
      var statistics = Marshal.PtrToStructure<TokenStatistics>(buffer);
      result.Authentication = statistics.AuthenticationId.ToString();
    } finally { Marshal.FreeHGlobal(buffer); }
    buffer = Info(token, 2, out length);
    try {
      int count = Marshal.ReadInt32(buffer), offset = (int)Marshal.OffsetOf<FirstGroup>("First"), stride = Marshal.SizeOf<SidAttributes>();
      TokenNeed(count > 0 && count <= 4096 && offset + count * stride <= length, "groups", "group-buffer-shape");
      for (int i = 0; i < count; i++) {
        var group = Marshal.PtrToStructure<SidAttributes>(IntPtr.Add(buffer, offset + i * stride));
        string sid = SidText(group.Sid, "groups");
        TokenNeed(!result.Groups.ContainsKey(sid), "groups", "duplicate-group-sid");
        result.Groups.Add(sid, group.Attributes);
        if ((group.Attributes & 0xc0000000) == 0xc0000000) { TokenNeed(result.Logon == null, "groups", "duplicate-logon-sid"); result.Logon = sid; }
      }
      TokenNeed(result.Logon != null, "groups", "missing-logon-sid");
    } finally { Marshal.FreeHGlobal(buffer); }
    buffer = Info(token, 3, out length);
    try {
      int count = Marshal.ReadInt32(buffer), stride = Marshal.SizeOf<LuidAttributes>();
      TokenNeed(count >= 0 && count <= 1024 && 4 + count * stride <= length, "privileges", "privilege-buffer-shape");
      for (int i = 0; i < count; i++) {
        var privilege = Marshal.PtrToStructure<LuidAttributes>(IntPtr.Add(buffer, 4 + i * stride));
        var text = new StringBuilder(256); int size = text.Capacity;
        TokenApi(LookupPrivilegeNameW(null, ref privilege.Luid, text, ref size), "privileges", "privilege-name-error");
        TokenNeed(!result.Privileges.ContainsKey(text.ToString()), "privileges", "duplicate-privilege");
        result.Privileges.Add(text.ToString(), privilege.Attributes);
      }
    } finally { Marshal.FreeHGlobal(buffer); }
    result.Type = Scalar(token, 8); result.Session = Scalar(token, 12); result.SandboxInert = Scalar(token, 15);
    result.Elevation = Scalar(token, 20); result.Integrity = Integrity(token); result.UIAccess = Scalar(token, 26);
    return result;
  }
  static bool PrivilegedGroup(string sid) {
    return Regex.IsMatch(sid, @"^S-1-5-32-(544|547|548|549|550|551|552)$") || Regex.IsMatch(sid, @"^S-1-5-21-\d+-\d+-\d+-(512|518|519|520)$");
  }
  static void AccountIdentity(TokenFacts source) {
    // Preserve the original short-circuit order; diagnostics never substitute a different identity.
    TokenNeed(source != null, "account", "facts-missing");
    TokenNeed(source.Type == 1, "account", "primary-required");
    TokenNeed(source.Integrity >= 8192, "account", "integrity-below-medium");
    TokenNeed(!String.IsNullOrEmpty(source.User), "account", "user-missing");
    TokenNeed(!String.IsNullOrEmpty(source.Authentication), "account", "authentication-missing");
    TokenNeed(!String.IsNullOrEmpty(source.Logon), "account", "logon-missing");
    TokenNeed(Regex.IsMatch(source.User, @"^S-1-5-21-\d+-\d+-\d+-[1-9]\d*$"), "account", "user-account-shape");
    TokenNeed(Regex.IsMatch(source.Authentication, "^[a-f0-9]{16}$"), "account", "authentication-shape");
    TokenNeed(source.Authentication != "0000000000000000", "account", "authentication-zero");
    TokenNeed(Regex.IsMatch(source.Logon, @"^S-1-5-5-\d+-\d+$"), "account", "logon-shape");
  }
  public static void ValidateOrdinary(TokenFacts source, TokenFacts candidate) {
    AccountIdentity(source); Need(candidate != null, "TOKEN_REJECTED");
    Need(candidate.User == source.User && candidate.Authentication == source.Authentication && candidate.Logon == source.Logon && candidate.Session == source.Session, "TOKEN_REJECTED");
    Need(source.Type == 1 && candidate.Type == 1 && candidate.Elevation == 0 && candidate.Integrity == 8192 && candidate.UIAccess == 0 && candidate.SandboxInert == 0, "TOKEN_REJECTED");
    Need(source.Groups != null && candidate.Groups != null && source.Privileges != null && candidate.Privileges != null, "TOKEN_REJECTED");
    foreach (var pair in source.Groups) {
      if ((pair.Value & 0x10) != 0) {
        uint retained;
        Need(candidate.Groups.TryGetValue(pair.Key, out retained) && (retained & 0x10) != 0, "TOKEN_REJECTED");
      }
    }
    foreach (var pair in candidate.Groups) {
      uint original;
      if (!source.Groups.TryGetValue(pair.Key, out original)) {
        // SetTokenInformation may replace the mandatory-label group. This only lowers it.
        Need(pair.Key == "S-1-16-8192" && source.Integrity > 8192 && candidate.Integrity == 8192 && (pair.Value & ~0x60u) == 0 && (pair.Value & 0x20) != 0, "TOKEN_REJECTED");
        continue;
      }
      Need((original & 0x10) == 0 || (pair.Value & 0x10) != 0, "TOKEN_REJECTED");
      // A disabled group must not become enabled/owner. A privileged group must be absent or deny-only.
      Need((pair.Value & 0x0c & ~original) == 0, "TOKEN_REJECTED");
      if (PrivilegedGroup(pair.Key)) Need((pair.Value & 0x10) != 0 && (pair.Value & 0x0c) == 0, "TOKEN_REJECTED");
    }
    foreach (var pair in candidate.Privileges) {
      uint original;
      Need(source.Privileges.TryGetValue(pair.Key, out original) && (pair.Value & 3 & ~original) == 0, "TOKEN_REJECTED");
      Need(pair.Key == "SeChangeNotifyPrivilege" || (pair.Value & 2) == 0, "TOKEN_REJECTED");
      // Unknown privileges are rejected too, including privileges present but disabled.
      Need(pair.Key == "SeChangeNotifyPrivilege" || pair.Key == "SeShutdownPrivilege" || pair.Key == "SeUndockPrivilege" || pair.Key == "SeIncreaseWorkingSetPrivilege" || pair.Key == "SeTimeZonePrivilege", "TOKEN_REJECTED");
    }
  }
  static void LowerIntegrity(IntPtr token) {
    uint integrity = Integrity(token);
    Need(integrity >= 8192, "TOKEN_REJECTED"); // Never raise low/untrusted tokens.
    if (integrity == 8192) return;
    IntPtr sid = IntPtr.Zero, buffer = IntPtr.Zero;
    try {
      Api(ConvertStringSidToSidW("S-1-16-8192", out sid));
      var label = new SidAttributes { Sid = sid, Attributes = 0x20 };
      buffer = Marshal.AllocHGlobal(Marshal.SizeOf<SidAttributes>());
      Marshal.StructureToPtr(label, buffer, false);
      Api(SetTokenInformation(token, 25, buffer, (uint)Marshal.SizeOf<SidAttributes>() + GetLengthSid(sid)));
    } finally { if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer); if (sid != IntPtr.Zero) LocalFree(sid); }
  }
  public static string Quote(string value) {
    var output = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') output.Append('\\', slashes * 2 + 1).Append('"');
      else output.Append('\\', slashes).Append(c);
      slashes = 0;
    }
    return output.Append('\\', slashes * 2).Append('"').ToString();
  }
  static uint ParentPid() {
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    Api(snapshot != new IntPtr(-1));
    try {
      var entry = new ProcessEntry(); entry.Size = (uint)Marshal.SizeOf<ProcessEntry>();
      Api(Process32FirstW(snapshot, ref entry)); uint self = GetProcessId(GetCurrentProcess());
      do { if (entry.Pid == self) { Need(entry.Parent != 0, "NATIVE_INPUT_INVALID"); return entry.Parent; } }
      while (Process32NextW(snapshot, ref entry));
      throw new GateFailure("NATIVE_INPUT_INVALID");
    } finally { Close(ref snapshot); }
  }
  static IntPtr VerifyNodeParent(string node) {
    Need(String.Equals(Path.GetFileName(node), "node.exe", StringComparison.OrdinalIgnoreCase), "FILE_IDENTITY_FAILED");
    IntPtr parent = OpenProcess(0x00101000, false, ParentPid()); Api(parent != IntPtr.Zero);
    try { Image(parent, node); Need(Creation(parent) <= Creation(GetCurrentProcess()) && WaitForSingleObject(parent, 0) == WaitTimeout, "CREATION_IDENTITY_MISMATCH"); return parent; }
    catch { Close(ref parent); throw; }
  }
  static string Hash(string file) {
    using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
    using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
  }
  static void RegularFile(string file) {
    Need(File.Exists(file) && (File.GetAttributes(file) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == 0, "FILE_IDENTITY_FAILED");
  }
  static long Creation(IntPtr process) {
    long created, exited, kernel, user; Api(GetProcessTimes(process, out created, out exited, out kernel, out user)); return created;
  }
  static void Image(IntPtr process, string expected) {
    var path = new StringBuilder(32768); int size = path.Capacity;
    Api(QueryFullProcessImageNameW(process, 0, path, ref size));
    Need(String.Equals(Path.GetFullPath(path.ToString()), Path.GetFullPath(expected), StringComparison.OrdinalIgnoreCase), "IMAGE_MISMATCH");
  }
  static uint Active(IntPtr job) {
    int size = Marshal.SizeOf<Accounting>(); IntPtr buffer = Marshal.AllocHGlobal(size);
    try { uint required; Api(QueryInformationJobObject(job, 1, buffer, (uint)size, out required)); return Marshal.PtrToStructure<Accounting>(buffer).Active; }
    finally { Marshal.FreeHGlobal(buffer); }
  }
  static uint Drain(IntPtr job, int milliseconds) {
    var deadline = Stopwatch.StartNew(); uint active;
    do { active = Active(job); if (active == 0) return 0; Thread.Sleep(50); } while (deadline.ElapsedMilliseconds < milliseconds);
    return active;
  }
  static string EnvironmentBlock(Dictionary<string,string> values, string mode, string id, string root) {
    var allowed = new HashSet<string>(new string[] { "SystemRoot", "WINDIR", "SystemDrive", "ProgramFiles", "ProgramFiles(x86)", "PROGRAMDATA", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "RUNNER_TEMP", "GITHUB_WORKSPACE", "GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "RUNNER_OS", "RW_WINDOWS_FRESH_RUNNER", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "ImageOS", "ImageVersion", "COMSPEC", "PATH", "RW_WINDOWS_BOOTSTRAP_ID", "RW_WINDOWS_BOOTSTRAP_MODE" }, StringComparer.Ordinal);
    Need(values.Count == allowed.Count, "NATIVE_INPUT_INVALID");
    var sorted = new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
    foreach (var pair in values) {
      Need(allowed.Contains(pair.Key) && pair.Value != null && pair.Value.Length < 4096 && !Regex.IsMatch(pair.Value, @"[\x00-\x1f]"), "NATIVE_INPUT_INVALID");
      sorted.Add(pair.Key, pair.Value);
    }
    Need(values["GITHUB_ACTIONS"] == "true" && values["RUNNER_ENVIRONMENT"] == "github-hosted" && values["RUNNER_OS"] == "Windows" && values["RW_WINDOWS_FRESH_RUNNER"] == "yes", "NATIVE_INPUT_INVALID");
    Need(values["RW_WINDOWS_BOOTSTRAP_MODE"] == mode && values["RW_WINDOWS_BOOTSTRAP_ID"] == id && String.Equals(values["GITHUB_WORKSPACE"], root, StringComparison.OrdinalIgnoreCase), "NATIVE_INPUT_INVALID");
    var result = new StringBuilder();
    foreach (var pair in sorted) result.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
    return result.Append('\0').ToString();
  }
  public static Outcome Run(string root, string node, string nodeHash, string mode, string id, Dictionary<string,string> environment) {
    var result = new Outcome(); IntPtr parent = IntPtr.Zero, source = IntPtr.Zero, level = IntPtr.Zero, safer = IntPtr.Zero, token = IntPtr.Zero, job = IntPtr.Zero, attributes = IntPtr.Zero, jobList = IntPtr.Zero, env = IntPtr.Zero;
    bool attributesInitialized = false; var child = new ProcessInformation(); FileStream nodeLease = null, scriptLease = null;
    try {
      Need((mode == "probe" || mode == "runtime") && Regex.IsMatch(id ?? "", "^[a-f0-9]{32}$") && Regex.IsMatch(nodeHash ?? "", "^[a-f0-9]{64}$"), "NATIVE_INPUT_INVALID");
      root = Path.GetFullPath(root); node = Path.GetFullPath(node);
      string script = Path.Combine(root, "scripts", "verify", mode == "probe" ? "windows-bootstrap-probe.mjs" : "windows-runtime.mjs");
      string directory = Path.Combine(root, ".cache", "windows-bootstrap-" + mode, id);
      Need(Directory.Exists(directory) && !File.Exists(Path.Combine(directory, "context.json")), "NATIVE_INPUT_INVALID");
      parent = VerifyNodeParent(node);
      RegularFile(node); RegularFile(script);
      nodeLease = new FileStream(node, FileMode.Open, FileAccess.Read, FileShare.Read);
      scriptLease = new FileStream(script, FileMode.Open, FileAccess.Read, FileShare.Read);
      Need(Hash(node) == nodeHash, "FILE_IDENTITY_FAILED");
      string block = EnvironmentBlock(environment, mode, id, root);
      result.phase = "self-test"; result.nativeTests = WindowsBootstrapNativeTests.Run();
      result.phase = "caller-token"; Api(OpenProcessToken(GetCurrentProcess(), DuplicateSource, out source)); NonInherited(source);
      var original = Facts(source); AccountIdentity(original);
      result.phase = "safer-level"; Api(SaferCreateLevel(2, 0x20000, 1, out level, IntPtr.Zero));
      result.phase = "safer-token"; Api(SaferComputeTokenFromLevel(level, source, out safer, 0, IntPtr.Zero)); Need(safer != IntPtr.Zero, "TOKEN_REJECTED");
      result.phase = "duplicate-token"; Api(DuplicateTokenEx(safer, LaunchToken, IntPtr.Zero, 2, 1, out token)); NonInherited(token);
      result.phase = "lower-integrity"; LowerIntegrity(token);
      result.phase = "validate-token"; ValidateOrdinary(original, Facts(token)); result.candidateVerified = true;
      result.phase = "job-create"; job = CreateJobObjectW(IntPtr.Zero, null); Api(job != IntPtr.Zero); NonInherited(job);
      result.phase = "job-configure";
      var limits = new ExtendedLimits(); limits.Basic.Flags = JobLimit;
      int limitSize = Marshal.SizeOf<ExtendedLimits>(); IntPtr limitBuffer = Marshal.AllocHGlobal(limitSize);
      try { Marshal.StructureToPtr(limits, limitBuffer, false); Api(SetInformationJobObject(job, 9, limitBuffer, (uint)limitSize)); }
      finally { Marshal.FreeHGlobal(limitBuffer); }
      result.phase = "attributes"; IntPtr attributeSize = IntPtr.Zero;
      bool initialized = InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
      int initError = Marshal.GetLastWin32Error(); Need(!initialized && initError == 122 && attributeSize.ToInt64() > 0 && attributeSize.ToInt64() < 65536, "NATIVE_API_FAILED");
      attributes = Marshal.AllocHGlobal(attributeSize); Api(InitializeProcThreadAttributeList(attributes, 1, 0, ref attributeSize)); attributesInitialized = true;
      jobList = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList, job);
      Api(UpdateProcThreadAttribute(attributes, 0, new IntPtr(JobAttribute), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      var startup = new StartupInfoEx(); startup.Startup.cb = Marshal.SizeOf<StartupInfoEx>(); startup.Attributes = attributes;
      // No STARTF_USESTDHANDLES, inherited handles, desktop override, breakaway or alternate credentials.
      env = Marshal.StringToHGlobalUni(block);
      result.phase = "create-process";
      Api(CreateProcessAsUserW(token, node, new StringBuilder(Quote(node) + " " + Quote(script)), IntPtr.Zero, IntPtr.Zero, false, CreationFlags, env, root, ref startup, out child));
      result.atomicJob = true;
      NonInherited(child.Process); NonInherited(child.Thread); result.noInheritedHandles = true;
      result.phase = "child-identity"; Need(GetProcessId(child.Process) == child.Pid && child.Pid != 0, "CREATION_IDENTITY_MISMATCH");
      long created = Creation(child.Process); Image(child.Process, node);
      Need(SameCreation(created, Creation(child.Process)) && WaitForSingleObject(child.Process, 0) == WaitTimeout && Hash(node) == nodeHash, "CREATION_IDENTITY_MISMATCH");
      result.phase = "child-token"; IntPtr actual = IntPtr.Zero;
      try { Api(OpenProcessToken(child.Process, QueryToken, out actual)); ValidateOrdinary(original, Facts(actual)); }
      finally { Close(ref actual); }
      result.childVerified = true;
      result.phase = "child-job"; bool member; Api(IsProcessInJob(child.Process, job, out member)); Need(member && Active(job) == 1, "JOB_MEMBERSHIP_FAILED");
      result.phase = "manifest";
      // Internal linkage only; no SID, authentication LUID, token or handle is serialized.
      string manifest = "{\"bootstrapId\":\"" + id + "\",\"mode\":\"" + mode + "\",\"pid\":" + child.Pid.ToString(CultureInfo.InvariantCulture) + ",\"created100ns\":\"" + created.ToString(CultureInfo.InvariantCulture) + "\",\"nodeSha256\":\"" + nodeHash + "\"}";
      using (var output = new FileStream(Path.Combine(directory, "context.json"), FileMode.CreateNew, FileAccess.Write, FileShare.Read)) {
        byte[] bytes = new UTF8Encoding(false).GetBytes(manifest); output.Write(bytes, 0, bytes.Length); output.Flush(true);
      }
      result.phase = "resume"; Need(WaitForSingleObject(parent, 0) == WaitTimeout, "BOOTSTRAP_PARENT_EXIT"); uint previous = ResumeThread(child.Thread);
      if (previous == WaitFailed) throw new GateFailure("NATIVE_API_FAILED", Marshal.GetLastWin32Error());
      Need(ExpectedResume(previous), "RESUME_COUNT_MISMATCH"); result.resumed = true;
      result.phase = "wait"; uint state = WaitForMultipleObjects(2, new IntPtr[] { child.Process, parent }, false, mode == "probe" ? 45000u : 540000u);
      if (state == WaitFailed) throw new GateFailure("NATIVE_API_FAILED", Marshal.GetLastWin32Error());
      Need(state != 1, "BOOTSTRAP_PARENT_EXIT");
      Need(state == 0, "CHILD_TIMEOUT"); result.exited = true;
      uint exitCode; Api(GetExitCodeProcess(child.Process, out exitCode)); result.exitCode = exitCode;
      result.phase = "job-drain"; result.activeProcesses = Drain(job, 3000);
      Need(exitCode == 0, "CHILD_EXIT_FAILED"); Need(result.activeProcesses == 0, "JOB_NOT_EMPTY");
      result.cleanupVerified = true; result.status = "PASS"; result.phase = "complete"; result.code = "OK";
    } catch (GateFailure failure) { result.code = failure.Code; result.win32Error = failure.Error; result.tokenFailure = failure.TokenFailure; }
      catch { result.code = "NATIVE_FAILURE"; }
    finally {
      if (child.Process != IntPtr.Zero) {
        bool exited = false; uint? active = null;
        try { exited = WaitForSingleObject(child.Process, 0) == 0; if (job != IntPtr.Zero) active = Active(job); } catch { }
        if (!exited || active != 0) {
          result.forcedTermination = true;
          // Best effort on each retained handle independently, even if job query/termination fails.
          try { if (job != IntPtr.Zero) Api(TerminateJobObject(job, 1)); } catch { }
          try { exited = WaitForSingleObject(child.Process, 5000) == 0; } catch { }
          if (!exited) {
            try { Api(TerminateProcess(child.Process, 1)); } catch { }
            try { exited = WaitForSingleObject(child.Process, 5000) == 0; } catch { }
          }
          try { if (job != IntPtr.Zero) active = Drain(job, 5000); } catch { active = null; }
        }
        result.exited = exited; result.activeProcesses = active;
        result.cleanupVerified = active.HasValue && CleanupProven(exited, active.Value);
        if (!result.cleanupVerified || result.forcedTermination) { result.status = "FAIL"; if (result.code == "OK") result.code = "CLEANUP_UNVERIFIED"; }
      }
      // The job handle is never inherited. Abrupt supervisor termination also closes the last handle.
      Close(ref job); Close(ref child.Thread); Close(ref child.Process); Close(ref parent);
      if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
      if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
      if (scriptLease != null) scriptLease.Dispose(); if (nodeLease != null) nodeLease.Dispose();
      Close(ref token); Close(ref safer); if (level != IntPtr.Zero) SaferCloseLevel(level); Close(ref source);
    }
    return result;
  }
  public static ContextOutcome Inspect(uint pid, string node, string createdText) {
    var result = new ContextOutcome(); IntPtr process = IntPtr.Zero, current = IntPtr.Zero, actual = IntPtr.Zero, desktop = IntPtr.Zero;
    try {
      long expected = 0; Need(pid > 0 && Int64.TryParse(createdText, NumberStyles.None, CultureInfo.InvariantCulture, out expected) && expected > 0, "NATIVE_INPUT_INVALID");
      Need(ParentPid() == pid, "CREATION_IDENTITY_MISMATCH");
      process = OpenProcess(0x00101000, false, pid); Api(process != IntPtr.Zero);
      result.phase = "child-identity"; Image(process, node); result.imageMatched = true;
      Need(SameCreation(Creation(process), expected), "CREATION_IDENTITY_MISMATCH"); result.exactCreation = true;
      result.phase = "child-token"; Api(OpenProcessToken(GetCurrentProcess(), QueryToken, out current)); Api(OpenProcessToken(process, QueryToken, out actual));
      var original = Facts(current); ValidateOrdinary(original, Facts(actual)); ValidateOrdinary(original, original);
      result.ordinary = true; result.sameIdentity = true;
      result.phase = "child-job"; bool member; Api(IsProcessInJob(process, IntPtr.Zero, out member)); Need(member, "JOB_MEMBERSHIP_FAILED"); result.jobMember = true;
      desktop = OpenInputDesktop(0, false, 1); Api(desktop != IntPtr.Zero); Need(Environment.UserInteractive, "NATIVE_INPUT_INVALID"); result.desktopAvailable = true;
      Need(SameCreation(Creation(process), expected) && WaitForSingleObject(process, 0) == WaitTimeout, "CREATION_IDENTITY_MISMATCH");
      result.status = "PASS"; result.phase = "complete"; result.code = "OK";
    } catch (GateFailure failure) { result.code = failure.Code; result.win32Error = failure.Error; result.tokenFailure = failure.TokenFailure; }
      catch { result.code = "NATIVE_FAILURE"; }
    finally { if (desktop != IntPtr.Zero) CloseDesktop(desktop); Close(ref actual); Close(ref current); Close(ref process); }
    return result;
  }
}
