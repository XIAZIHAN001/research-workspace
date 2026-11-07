using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

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
  static void RejectDetail(Action action, string field, string reason, int error = 0) {
    try { action(); } catch (WindowsBootstrapNative.GateFailure failure) {
      Check(failure.TokenFailure != null && failure.TokenFailure.field == field && failure.TokenFailure.reason == reason && failure.Error == error);
      return;
    }
    throw new InvalidOperationException("NATIVE_SELF_TEST_FAILED");
  }
  static void RejectPolicy(Action<WindowsBootstrapNative.TokenFacts> changeSource, Action<WindowsBootstrapNative.TokenFacts> changeCandidate, string field, string reason) {
    var source = Token(); var candidate = Token();
    if (changeSource != null) changeSource(source);
    if (changeCandidate != null) changeCandidate(candidate);
    RejectDetail(() => WindowsBootstrapNative.ValidateOrdinary(source, candidate), field, reason);
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
    WindowsBootstrapNative.ValidateInfoSize(false, 122, 24, 1); count++;
    RejectDetail(() => WindowsBootstrapNative.ValidateInfoSize(false, 5, 0, 2), "groups", "size-query-error", 5); count++;
    RejectDetail(() => WindowsBootstrapNative.ValidateInfoSize(true, 999, 24, 1), "user", "size-query-unexpected-success"); count++;
    RejectDetail(() => WindowsBootstrapNative.ValidateInfoSize(false, 122, 0, 3), "privileges", "buffer-size"); count++;
    RejectDetail(() => WindowsBootstrapNative.ValidateInfoSize(false, 122, 1048577, 25), "integrity", "buffer-size"); count++;
    var invalidAccount = Token(); invalidAccount.User = "S-1-5-18";
    RejectDetail(() => WindowsBootstrapNative.ValidateOrdinary(invalidAccount, Token()), "account", "user-account-shape"); count++;
    invalidAccount = Token(); invalidAccount.Authentication = "0000000000000000";
    RejectDetail(() => WindowsBootstrapNative.ValidateOrdinary(invalidAccount, Token()), "account", "authentication-zero"); count++;
    invalidAccount = Token(); invalidAccount.Logon = "not-a-logon";
    RejectDetail(() => WindowsBootstrapNative.ValidateOrdinary(invalidAccount, Token()), "account", "logon-shape"); count++;
    invalidAccount = Token(); invalidAccount.Type = 2;
    RejectDetail(() => WindowsBootstrapNative.ValidateOrdinary(invalidAccount, Token()), "account", "primary-required"); count++;
    invalidAccount = Token(); invalidAccount.Integrity = 4096;
    RejectDetail(() => WindowsBootstrapNative.ValidateOrdinary(invalidAccount, Token()), "account", "integrity-below-medium"); count++;
    // Replay the observed elevation contract: NULL/zero returns ERROR_BAD_LENGTH, typed four-byte read succeeds.
    foreach (int kind in new int[] { 8, 12, 15, 20, 26 }) {
      int calls = 0;
      uint value = WindowsBootstrapNative.ReadScalar(kind, (int requested, IntPtr buffer, uint capacity, out uint length, out int error) => {
        calls++; Check(requested == kind); length = 4;
        if (buffer == IntPtr.Zero || capacity == 0) { error = 24; return false; }
        Check(capacity == 4); Marshal.WriteInt32(buffer, 1); error = 0; return true;
      });
      Check(value == 1 && calls == 1); count++;
    }
    foreach (uint returned in new uint[] { 0, 3, 8 }) {
      RejectDetail(() => WindowsBootstrapNative.ReadScalar(20, (int requested, IntPtr buffer, uint capacity, out uint length, out int error) => {
        Check(requested == 20 && buffer != IntPtr.Zero && capacity == 4); length = returned; error = 0; return true;
      }), "elevation", "scalar-size"); count++;
    }
    int failedCalls = 0;
    RejectDetail(() => WindowsBootstrapNative.ReadScalar(20, (int requested, IntPtr buffer, uint capacity, out uint length, out int error) => {
      failedCalls++; Check(requested == 20 && buffer != IntPtr.Zero && capacity == 4); length = 4; error = 24; return false;
    }), "elevation", "read-query-error", 24); Check(failedCalls == 1); count++;
    bool unknownQueried = false;
    RejectDetail(() => WindowsBootstrapNative.ReadScalar(25, (int requested, IntPtr buffer, uint capacity, out uint length, out int error) => {
      unknownQueried = true; length = 4; error = 0; return true;
    }), "integrity", "scalar-class"); Check(!unknownQueried); count++;
    RejectDetail(() => WindowsBootstrapNative.ValidateOrdinary(Token(), null), "identity", "candidate-facts-missing"); count++;
    RejectPolicy(null, t => t.User = "other", "identity", "user-mismatch"); count++;
    RejectPolicy(null, t => t.Authentication = "other", "identity", "authentication-mismatch"); count++;
    RejectPolicy(null, t => t.Logon = "other", "identity", "logon-mismatch"); count++;
    RejectPolicy(null, t => t.Session = 2, "identity", "session-mismatch"); count++;
    RejectPolicy(null, t => t.Type = 2, "type", "primary-required"); count++;
    RejectPolicy(null, t => t.Elevation = 1, "elevation", "nonzero-elevation"); count++;
    RejectPolicy(null, t => t.Integrity = 12288, "integrity", "not-exact-medium"); count++;
    RejectPolicy(null, t => t.UIAccess = 1, "ui-access", "ui-access-not-zero"); count++;
    RejectPolicy(null, t => t.SandboxInert = 1, "sandbox", "sandbox-inert-not-zero"); count++;
    RejectPolicy(t => t.Groups = null, null, "groups", "source-list-missing"); count++;
    RejectPolicy(null, t => t.Groups = null, "groups", "candidate-list-missing"); count++;
    RejectPolicy(t => t.Privileges = null, null, "privileges", "source-list-missing"); count++;
    RejectPolicy(null, t => t.Privileges = null, "privileges", "candidate-list-missing"); count++;
    RejectPolicy(null, t => t.Groups.Remove("S-1-5-32-544"), "groups", "source-deny-only-group-missing"); count++;
    RejectPolicy(null, t => t.Groups["S-1-5-32-544"] = 0, "groups", "source-deny-only-flag-lost"); count++;
    RejectPolicy(null, t => t.Groups["new-group"] = 0, "groups", "new-group-not-medium-label"); count++;
    RejectPolicy(null, t => t.Groups["S-1-16-8192"] = 0x60, "groups", "label-source-not-higher"); count++;
    RejectPolicy(t => t.Integrity = 12288, t => t.Groups["S-1-16-8192"] = 0x64, "groups", "label-attributes-unexpected"); count++;
    RejectPolicy(t => t.Integrity = 12288, t => t.Groups["S-1-16-8192"] = 0, "groups", "label-integrity-attribute-missing"); count++;
    RejectPolicy(t => t.Groups["S-1-5-32-545"] = 0, t => t.Groups["S-1-5-32-545"] = 4, "groups", "group-authority-added"); count++;
    RejectPolicy(t => t.Groups["S-1-5-32-544"] = 0, t => t.Groups["S-1-5-32-544"] = 0, "groups", "privileged-group-not-deny-only"); count++;
    RejectPolicy(t => t.Groups["S-1-5-32-544"] = 4, t => t.Groups["S-1-5-32-544"] = 0x14, "groups", "privileged-group-authority-present"); count++;
    RejectPolicy(null, t => t.Privileges["SeTimeZonePrivilege"] = 0, "privileges", "privilege-added"); count++;
    RejectPolicy(t => t.Privileges["SeChangeNotifyPrivilege"] = 0, null, "privileges", "privilege-activation-added"); count++;
    RejectPolicy(t => t.Privileges["SeTimeZonePrivilege"] = 2, t => t.Privileges["SeTimeZonePrivilege"] = 2, "privileges", "non-traversal-privilege-enabled"); count++;
    RejectPolicy(t => t.Privileges["SeDebugPrivilege"] = 0, t => t.Privileges["SeDebugPrivilege"] = 0, "privileges", "privilege-not-allowlisted"); count++;
    // Earlier identity predicates retain their priority when multiple properties are invalid.
    RejectPolicy(null, t => { t.User = "other"; t.Elevation = 1; }, "identity", "user-mismatch"); count++;
    return count;
  }
}
