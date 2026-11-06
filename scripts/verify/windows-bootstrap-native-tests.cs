using System;
using System.Collections.Generic;

// Synthetic policy tests only. Probe/run still exercise the actual Windows APIs separately.
public static class WindowsBootstrapNativeTests {
  static WindowsBootstrapNative.TokenFacts Token() {
    return new WindowsBootstrapNative.TokenFacts {
      User = "S-1-5-21-1-2-3-1001", Authentication = "0000000000001234", Logon = "S-1-5-5-0-4660", Session = 1,
      Type = 1, Integrity = 8192, Elevation = 0, UIAccess = 0, SandboxInert = 0,
      Groups = new Dictionary<string,uint> { { "S-1-5-32-544", 0x10 }, { "S-1-5-5-0-4660", 0xc0000004 } },
      Privileges = new Dictionary<string,uint> { { "SeChangeNotifyPrivilege", 3 } }
    };
  }
  static void Check(bool value) { if (!value) throw new InvalidOperationException("NATIVE_SELF_TEST_FAILED"); }
  static void Reject(Action action) {
    try { action(); } catch (WindowsBootstrapNative.GateFailure) { return; }
    throw new InvalidOperationException("NATIVE_SELF_TEST_FAILED");
  }
  public static int Run() {
    int count = 0;
    WindowsBootstrapNative.ValidateOrdinary(Token(), Token()); count++;
    foreach (Action<WindowsBootstrapNative.TokenFacts> mutate in new Action<WindowsBootstrapNative.TokenFacts>[] {
      t => t.User = "other", t => t.Authentication = "other", t => t.Logon = "other", t => t.Session = 2,
      t => t.Type = 2, t => t.Integrity = 4096, t => t.Integrity = 12288, t => t.Elevation = 1,
      t => t.UIAccess = 1, t => t.SandboxInert = 1,
      t => t.Groups["S-1-5-32-544"] = 0, t => t.Groups["S-1-5-32-544"] = 4,
      t => t.Privileges["SeDebugPrivilege"] = 0,
      t => t.Privileges["SeImpersonatePrivilege"] = 0,
      t => t.Privileges["SeTimeZonePrivilege"] = 0,
      t => t.Groups["new-group"] = 4,
      t => t.Logon = null
    }) {
      var candidate = Token(); mutate(candidate);
      Reject(() => WindowsBootstrapNative.ValidateOrdinary(Token(), candidate)); count++;
    }
    foreach (string identity in new string[] { "S-1-5-18", "S-1-5-19", "S-1-5-20", "not-an-account" }) {
      var a = Token(); var b = Token(); a.User = b.User = identity;
      Reject(() => WindowsBootstrapNative.ValidateOrdinary(a, b)); count++;
    }
    foreach (string privilege in new string[] { "SeShutdownPrivilege", "SeUndockPrivilege", "SeIncreaseWorkingSetPrivilege", "SeTimeZonePrivilege" }) {
      var a = Token(); var b = Token(); a.Privileges[privilege] = b.Privileges[privilege] = 0;
      WindowsBootstrapNative.ValidateOrdinary(a, b); count++;
      a.Privileges[privilege] = b.Privileges[privilege] = 2;
      Reject(() => WindowsBootstrapNative.ValidateOrdinary(a, b)); count++;
    }
    var groupSource = Token(); var groupCandidate = Token();
    groupSource.Groups["S-1-5-32-545"] = 0x10; groupCandidate.Groups["S-1-5-32-545"] = 0;
    Reject(() => WindowsBootstrapNative.ValidateOrdinary(groupSource, groupCandidate)); count++;
    groupCandidate.Groups.Remove("S-1-5-32-545");
    Reject(() => WindowsBootstrapNative.ValidateOrdinary(groupSource, groupCandidate)); count++;
    var high = Token(); high.Integrity = 12288; high.Groups["S-1-16-12288"] = 0x60;
    var medium = Token(); medium.Groups["S-1-16-8192"] = 0x60;
    WindowsBootstrapNative.ValidateOrdinary(high, medium); count++;
    var source = Token(); source.Privileges["SeChangeNotifyPrivilege"] = 0;
    Reject(() => WindowsBootstrapNative.ValidateOrdinary(source, Token())); count++;
    Check(WindowsBootstrapNative.SameCreation(133000000000000001, 133000000000000001)); count++;
    Check(!WindowsBootstrapNative.SameCreation(133000000000000001, 133000000000000002)); count++;
    Check(WindowsBootstrapNative.Quote("C:\\Program Files\\node.exe") == "\"C:\\Program Files\\node.exe\""); count++;
    Check(WindowsBootstrapNative.Quote("C:\\tail\\") == "\"C:\\tail\\\\\""); count++;
    WindowsBootstrapNative.NoInheritance(0); count++;
    Reject(() => WindowsBootstrapNative.NoInheritance(1)); count++;
    Check(WindowsBootstrapNative.CreationFlags == 0x08080404); count++;
    Check(WindowsBootstrapNative.JobAttribute == 0x0002000d); count++;
    Check(WindowsBootstrapNative.JobLimit == 0x00002000); count++;
    Check(WindowsBootstrapNative.ExpectedResume(1)); count++;
    Check(!WindowsBootstrapNative.ExpectedResume(0) && !WindowsBootstrapNative.ExpectedResume(2) && !WindowsBootstrapNative.ExpectedResume(0xffffffff)); count++;
    Check(WindowsBootstrapNative.CleanupProven(true, 0)); count++;
    Check(!WindowsBootstrapNative.CleanupProven(false, 0) && !WindowsBootstrapNative.CleanupProven(true, 1)); count++;
    return count;
  }
}
