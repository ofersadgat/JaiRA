/**
 * The System tools on Windows (decision 0019 §2): PowerShell, .NET and the programs every Windows has —
 * and no WMI, because a hung WMI is what hangs `taskkill` (`killTree.ts`). What PowerShell 5.1 does
 * not expose (parent pids, windows, input, the screen) is reached through `Add-Type`, as the tree
 * walk already does, so nothing native ships.
 *
 * Every script reads the call's arguments from `$A` (see `powershell.ts`): no value a call supplied is
 * ever spliced into a script.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@declarative-ai/exec";
import { TREE_WALK } from "../killTree";
import { listOf, PowerShellRefusal, runPowerShell } from "./powershell";
import {
  SystemToolRefusal,
  type ClipboardContent,
  type ClipboardWrite,
  type InputStep,
  type InstallRequest,
  type InstallResult,
  type LogQuery,
  type OpenRequest,
  type PowerAction,
  type ProcessRow,
  type ReadSettingsRequest,
  type ScreenPicture,
  type ScreenshotRequest,
  type ServiceAction,
  type ServiceRow,
  type SoftwareKind,
  type SoftwareRow,
  type StartType,
  type SystemAbout,
  type SystemBackend,
  type WindowRow,
  type WriteSettingsRequest,
} from "./types";

/** Run a script, saying a script's own refusal as a refusal. */
async function ps<T>(script: string, args: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  try {
    return await runPowerShell<T>(script, args, options);
  } catch (e) {
    if (e instanceof PowerShellRefusal) throw new SystemToolRefusal(e.message);
    throw e;
  }
}

/**
 * The script's way of saying "this needs an administrator": a .NET access-denied anywhere in the
 * exception, which is how the Service Control Manager and the registry refuse a process without one.
 */
const ADMIN_CHECK = `
function Test-Denied($err) { return ($err.Exception.ToString() -match 'Access is denied|AccessDenied|UnauthorizedAccess|PermissionDenied|requested registry access is not allowed') }
`;

/**
 * Per-monitor DPI awareness, so window bounds, the screen and the mouse are all in the screen's own
 * pixels — PowerShell is otherwise DPI-unaware, and Windows would hand it scaled coordinates.
 */
const DPI_AWARE = `
[void][JairaDesk]::Aware()
`;

/** The window, screen and input calls, compiled once a script. */
const DESK_TYPE = `
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
public static class JairaDesk {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLengthW(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT value, int size);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr h, int index);

  public static bool Aware() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return true; } catch { }
    try { return SetProcessDPIAware(); } catch { return false; }
  }

  static bool Cloaked(IntPtr h) { int v; return DwmGetWindowAttribute(h, 14, out v, 4) == 0 && v != 0; }

  /** The bounds a window is drawn at, without the invisible resize border Windows 10 adds. */
  public static RECT Bounds(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) == 0) return r;
    GetWindowRect(h, out r);
    return r;
  }

  /** What Alt-Tab leaves out: tool windows, and windows that never take the keyboard unless they say they are apps. */
  static bool Tool(IntPtr h) { int ex = GetWindowLongW(h, -20); return (ex & 0x80) != 0 || ((ex & 0x08000000) != 0 && (ex & 0x40000) == 0); }

  /** The top-level windows a person sees: visible, titled, not cloaked, owned by nobody — as Alt-Tab lists them. */
  public static string[] List() {
    var rows = new List<string>();
    IntPtr focused = GetForegroundWindow();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero || Cloaked(h) || Tool(h)) return true;
      int n = GetWindowTextLengthW(h);
      if (n == 0) return true;
      var s = new StringBuilder(n + 1);
      GetWindowTextW(h, s, s.Capacity);
      uint pid; GetWindowThreadProcessId(h, out pid);
      RECT r = Bounds(h);
      rows.Add(h.ToInt64() + "|" + pid + "|" + (h == focused ? 1 : 0) + "|" + (IsIconic(h) ? 1 : 0) + "|" + r.Left + "|" + r.Top + "|" + (r.Right - r.Left) + "|" + (r.Bottom - r.Top) + "|" + s.ToString());
      return true;
    }, IntPtr.Zero);
    return rows.ToArray();
  }

  public static uint PidOf(long handle) { uint pid; GetWindowThreadProcessId(new IntPtr(handle), out pid); return pid; }
  public static bool Exists(long handle) { return IsWindow(new IntPtr(handle)); }

  /** Bring a window forward. Windows lets only the foreground process do that, so an Alt press first makes this one count as having had input. */
  public static bool Focus(long handle) {
    IntPtr h = new IntPtr(handle);
    if (IsIconic(h)) ShowWindow(h, 9);
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    return SetForegroundWindow(h);
  }

  public static bool Close(long handle) { return PostMessageW(new IntPtr(handle), 0x0010, IntPtr.Zero, IntPtr.Zero); }

  /** A window's own picture, drawn by the window (it may be behind others); null when it will not draw. */
  public static Bitmap Window(long handle, out int x, out int y) {
    IntPtr h = new IntPtr(handle);
    RECT r = Bounds(h);
    RECT full; GetWindowRect(h, out full);
    x = r.Left; y = r.Top;
    int w = full.Right - full.Left, ht = full.Bottom - full.Top;
    if (w <= 0 || ht <= 0) return null;
    var whole = new Bitmap(w, ht, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(whole)) {
      IntPtr dc = g.GetHdc();
      bool ok = PrintWindow(h, dc, 2);
      g.ReleaseHdc(dc);
      if (!ok) { whole.Dispose(); return null; }
    }
    var crop = new Rectangle(r.Left - full.Left, r.Top - full.Top, r.Right - r.Left, r.Bottom - r.Top);
    crop.Intersect(new Rectangle(0, 0, w, ht));
    var shot = whole.Clone(crop, PixelFormat.Format32bppArgb);
    whole.Dispose();
    return shot;
  }

  /** A rectangle of the screen, as the screen shows it. */
  public static Bitmap Screen(int x, int y, int w, int h) {
    var shot = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(shot)) g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
    return shot;
  }

  /** Scaled so the long side is at most \`maxSide\`, as a PNG. */
  public static byte[] Png(Bitmap shot, int maxSide, out int width, out int height) {
    double scale = Math.Min(1.0, (double)maxSide / Math.Max(shot.Width, shot.Height));
    width = Math.Max(1, (int)Math.Round(shot.Width * scale));
    height = Math.Max(1, (int)Math.Round(shot.Height * scale));
    Bitmap output = shot;
    if (scale < 1.0) {
      output = new Bitmap(width, height, PixelFormat.Format24bppRgb);
      using (var g = Graphics.FromImage(output)) {
        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
        g.DrawImage(shot, 0, 0, width, height);
      }
    }
    using (var ms = new System.IO.MemoryStream()) {
      output.Save(ms, ImageFormat.Png);
      if (!object.ReferenceEquals(output, shot)) output.Dispose();
      return ms.ToArray();
    }
  }
}
'@
`;

/** The toolhelp snapshot's parent pids — PowerShell 5.1 has no parent pid of its own, and WMI is out. */
const PARENTS_TYPE = `
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class JairaParents {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Entry {
    public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
    public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase;
    public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static Dictionary<int, int> All() {
    var parents = new Dictionary<int, int>();
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) return parents;
    try {
      Entry entry = new Entry(); entry.dwSize = (uint)Marshal.SizeOf(typeof(Entry));
      for (bool more = Process32FirstW(snapshot, ref entry); more; more = Process32NextW(snapshot, ref entry)) parents[(int)entry.th32ProcessID] = (int)entry.th32ParentProcessID;
    } finally { CloseHandle(snapshot); }
    return parents;
  }
}
'@
`;

const READ_SYSTEM = `
$about = $A.about
function Reg($path) { Get-ItemProperty -LiteralPath $path -ErrorAction SilentlyContinue }
switch ($about) {
  'summary' {
    $cv = Reg 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'
    $name = [string]$cv.ProductName
    # Windows 11 still writes "Windows 10" here; the build says which it is.
    if ([int]$cv.CurrentBuild -ge 22000) { $name = $name -replace 'Windows 10', 'Windows 11' }
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    Out-Result @{
      os = @{ name = $name; version = [string]$cv.DisplayVersion; build = "$($cv.CurrentBuild).$($cv.UBR)"; edition = [string]$cv.EditionID }
      elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
      time_zone = [TimeZoneInfo]::Local.Id
    }
  }
  'hardware' {
    $cpu = Reg 'HKLM:\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0'
    $bios = Reg 'HKLM:\\HARDWARE\\DESCRIPTION\\System\\BIOS'
    $gpus = @()
    $class = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'
    foreach ($key in (Get-ChildItem -LiteralPath $class -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match '^\\d{4}$' })) {
      $p = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
      if ($p.DriverDesc) {
        $mem = $p.'HardwareInformation.qwMemorySize'
        $gpus += @{ name = [string]$p.DriverDesc; driver = [string]$p.DriverVersion; memory_mb = $(if ($mem) { [math]::Round([double]$mem / 1MB) } else { $null }) }
      }
    }
    Out-Result @{
      cpu = [string]$cpu.ProcessorNameString
      gpus = @($gpus)
      machine = @{ manufacturer = [string]$bios.SystemManufacturer; model = [string]$bios.SystemProductName; bios = [string]$bios.BIOSVersion }
    }
  }
  'disks' {
    $rows = foreach ($d in [System.IO.DriveInfo]::GetDrives()) {
      if (-not $d.IsReady) { @{ name = $d.Name; type = "$($d.DriveType)".ToLower(); ready = $false }; continue }
      @{ name = $d.Name; label = $d.VolumeLabel; type = "$($d.DriveType)".ToLower(); format = $d.DriveFormat; size_gb = [math]::Round($d.TotalSize / 1GB, 1); free_gb = [math]::Round($d.AvailableFreeSpace / 1GB, 1); ready = $true }
    }
    Out-Result @($rows)
  }
  'network' {
    $rows = foreach ($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
      $ip = $n.GetIPProperties()
      @{
        name = $n.Name; description = $n.Description; type = "$($n.NetworkInterfaceType)"; status = "$($n.OperationalStatus)".ToLower()
        mac = ($n.GetPhysicalAddress().ToString() -replace '(..)(?!$)', '$1:')
        addresses = @($ip.UnicastAddresses | ForEach-Object { $_.Address.ToString() })
        gateways = @($ip.GatewayAddresses | ForEach-Object { $_.Address.ToString() })
        dns = @($ip.DnsAddresses | ForEach-Object { $_.ToString() })
      }
    }
    Out-Result @($rows)
  }
  'users' {
    $me = [Security.Principal.WindowsIdentity]::GetCurrent()
    $users = @()
    if (Get-Command Get-LocalUser -ErrorAction SilentlyContinue) {
      $users = @(Get-LocalUser | ForEach-Object { @{ name = $_.Name; enabled = $_.Enabled; description = $_.Description; last_logon = $(if ($_.LastLogon) { $_.LastLogon.ToUniversalTime().ToString('o') } else { $null }) } })
    }
    Out-Result @{ current = $me.Name; users = $users }
  }
  'logs' {
    $filter = @{ LogName = $(if ($A.log) { [string]$A.log } else { 'System' }); StartTime = (Get-Date).AddMinutes(-[double]$A.sinceMinutes) }
    $levels = @{ critical = @(1); error = @(1, 2); warning = @(1, 2, 3); information = @(1, 2, 3, 4, 0) }
    if ($A.level) { $filter.Level = $levels[[string]$A.level] }
    try {
      $events = Get-WinEvent -FilterHashtable $filter -MaxEvents ([int]$A.limit) -ErrorAction Stop
    } catch {
      if ($_.FullyQualifiedErrorId -match 'NoMatchingEventsFound') { Out-Result @(); return }
      throw
    }
    $rows = foreach ($e in $events) {
      $message = [string]$e.Message
      if ($message.Length -gt 2000) { $message = $message.Substring(0, 2000) + '…' }
      @{ time = $e.TimeCreated.ToUniversalTime().ToString('o'); level = [string]$e.LevelDisplayName; provider = $e.ProviderName; id = $e.Id; message = $message }
    }
    Out-Result @($rows)
  }
}
`;

const PROCESSES = `
${PARENTS_TYPE}
$parents = [JairaParents]::All()
$rows = foreach ($p in Get-Process) {
  $row = @{ pid = $p.Id; name = $p.ProcessName; memory_mb = [math]::Round($p.WorkingSet64 / 1MB, 1) }
  if ($parents.ContainsKey($p.Id)) { $row.parent_pid = $parents[$p.Id] }
  try { $row.started = $p.StartTime.ToUniversalTime().ToString('o') } catch { }
  try { $row.cpu_seconds = [math]::Round($p.TotalProcessorTime.TotalSeconds, 1) } catch { }
  try { if ($p.Path) { $row.path = $p.Path } } catch { }
  if ($p.MainWindowTitle) { $row.window_title = $p.MainWindowTitle }
  $row
}
Out-Result @($rows)
`;

const STOP_PROCESS = `
${TREE_WALK}
$p = Get-Process -Id ([int]$A.pid) -ErrorAction SilentlyContinue
if (-not $p) { Out-Refusal "no process $($A.pid) is running"; return }
if ($A.started) {
  $started = $null
  try { $started = $p.StartTime.ToUniversalTime().ToString('o') } catch { }
  if ($started -ne [string]$A.started) { Out-Refusal "process $($A.pid) is not the one listed: that one has ended, and the number is another program's now"; return }
}
if ($A.tree) {
  $code = [JairaTree]::Kill([int]$A.pid, [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()))
  if ($code -ne 0) { throw "the process tree could not be walked (code $code)" }
  Out-Result @{ stopped = $true; how = 'stopped, with every process it started' }
  return
}
if (-not $A.force -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
  [void]$p.CloseMainWindow()
  if ($p.WaitForExit(5000)) { Out-Result @{ stopped = $true; how = 'closed its window, and it exited' }; return }
}
$p.Kill()
[void]$p.WaitForExit(5000)
Out-Result @{ stopped = $true; how = 'terminated' }
`;

const SERVICE_ROW = `
function Row($s) {
  $state = switch ("$($s.Status)") { 'Running' { 'running' } 'Stopped' { 'stopped' } 'Paused' { 'paused' } 'StartPending' { 'start_pending' } 'StopPending' { 'stop_pending' } 'ContinuePending' { 'continue_pending' } 'PausePending' { 'pause_pending' } default { 'unknown' } }
  $row = @{ name = $s.Name; display_name = $s.DisplayName; status = $state; can_stop = $s.CanStop }
  try { $row.start_type = "$($s.StartType)".ToLower() } catch { }
  $row
}
`;

const SERVICES = `
${SERVICE_ROW}
Out-Result @(Get-Service -ErrorAction SilentlyContinue | ForEach-Object { Row $_ })
`;

const CONTROL_SERVICE = `
${SERVICE_ROW}
${ADMIN_CHECK}
$s = Get-Service -Name ([string]$A.name) -ErrorAction SilentlyContinue
if (-not $s) { Out-Refusal "there is no service named '$($A.name)' — list_services lists them"; return }
try {
  switch ([string]$A.action) {
    'start' { Start-Service -InputObject $s }
    'stop' { Stop-Service -InputObject $s }
    'restart' { Restart-Service -InputObject $s }
    'pause' { Suspend-Service -InputObject $s }
    'resume' { Resume-Service -InputObject $s }
    'set_start_type' {
      $type = switch ([string]$A.startType) { 'automatic' { 'Automatic' } 'manual' { 'Manual' } 'disabled' { 'Disabled' } }
      Set-Service -Name $s.Name -StartupType $type
    }
  }
} catch {
  if (Test-Denied $_) { Out-Refusal "changing the service '$($s.Name)' needs an administrator, and JaiRA is not running as one — run JaiRA as administrator, or change it yourself in Services"; return }
  throw
}
$s.Refresh()
Out-Result (Row (Get-Service -Name $s.Name))
`;

const SOFTWARE = `
switch ([string]$A.kind) {
  'programs' {
    $keys = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
    $rows = foreach ($p in (Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue)) {
      if (-not $p.DisplayName -or $p.SystemComponent -eq 1 -or $p.ParentKeyName) { continue }
      $row = @{ name = [string]$p.DisplayName; kind = 'program'; id = $p.PSChildName }
      if ($p.DisplayVersion) { $row.version = [string]$p.DisplayVersion }
      if ($p.Publisher) { $row.publisher = [string]$p.Publisher }
      if ($p.InstallDate) { $row.installed = [string]$p.InstallDate }
      $row
    }
    Out-Result @($rows)
  }
  'apps' {
    $rows = foreach ($p in (Get-AppxPackage -ErrorAction SilentlyContinue)) {
      if ($p.IsFramework -or $p.SignatureKind -eq 'System') { continue }
      @{ name = $p.Name; id = $p.PackageFamilyName; version = "$($p.Version)"; publisher = $p.Publisher; kind = 'app' }
    }
    Out-Result @($rows)
  }
  'modules' {
    $seen = @{}
    $rows = foreach ($m in (Get-Module -ListAvailable -ErrorAction SilentlyContinue)) {
      $key = "$($m.Name)@$($m.Version)"
      if ($seen.ContainsKey($key)) { continue }
      $seen[$key] = $true
      @{ name = $m.Name; id = $m.Name; version = "$($m.Version)"; kind = 'module' }
    }
    Out-Result @($rows)
  }
}
`;

const READ_SETTINGS = `
function Secret([string]$name) { return $name -match '(TOKEN|SECRET|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|PRIVATE|CREDENTIAL)' }
switch ([string]$A.area) {
  'registry' {
    $key = Get-Item -LiteralPath ([string]$A.path) -ErrorAction SilentlyContinue
    if (-not $key) { Out-Refusal "there is no registry key '$($A.key)'"; return }
    $names = if ($A.name) { @([string]$A.name) } else { @($key.GetValueNames()) }
    $values = foreach ($n in $names) {
      if ($A.name -and -not ($key.GetValueNames() -contains $n)) { Out-Refusal "the key '$($A.key)' has no value named '$n'"; return }
      $kind = $key.GetValueKind($n)
      $data = $key.GetValue($n, $null, 'DoNotExpandEnvironmentNames')
      if ($kind -eq 'Binary') { $data = [Convert]::ToBase64String([byte[]]$data) }
      @{ name = $(if ($n -eq '') { '(default)' } else { $n }); type = "$kind".ToLower(); value = $data }
    }
    $subkeys = @($key.GetSubKeyNames())
    Out-Result @{ key = [string]$A.key; values = @($values); subkeys = @($subkeys | Select-Object -First 500); subkey_count = $subkeys.Count }
  }
  'environment' {
    $rows = foreach ($scope in 'User', 'Machine') {
      $vars = [Environment]::GetEnvironmentVariables($scope)
      foreach ($name in ($vars.Keys | Sort-Object)) {
        if ($A.name -and $name -ne [string]$A.name) { continue }
        $value = [string]$vars[$name]
        if (Secret $name) { @{ name = $name; scope = $scope.ToLower(); withheld = 'its name says it holds a secret' } }
        else { @{ name = $name; scope = $scope.ToLower(); value = $value } }
      }
    }
    Out-Result @($rows)
  }
  'time' {
    $zone = [TimeZoneInfo]::Local
    $now = [DateTimeOffset]::Now
    Out-Result @{ now = $now.ToString('o'); time_zone = $zone.Id; display_name = $zone.DisplayName; utc_offset = $now.Offset.ToString(); daylight_saving = $zone.IsDaylightSavingTime($now) }
  }
}
`;

const WRITE_SETTINGS = `
${ADMIN_CHECK}
try {
  switch ([string]$A.area) {
    'registry' {
      $path = [string]$A.path
      if ($A.delete) {
        if (-not (Test-Path -LiteralPath $path)) { Out-Refusal "there is no registry key '$($A.key)'"; return }
        Remove-ItemProperty -LiteralPath $path -Name ([string]$A.name)
        Out-Result @{ deleted = $true; key = [string]$A.key; name = [string]$A.name }
        return
      }
      if (-not (Test-Path -LiteralPath $path)) { New-Item -Path $path -Force | Out-Null }
      $kind = switch ([string]$A.type) { 'expand_string' { 'ExpandString' } 'multi_string' { 'MultiString' } 'dword' { 'DWord' } 'qword' { 'QWord' } 'binary' { 'Binary' } default { 'String' } }
      $value = switch ($kind) {
        'DWord' { [int32]$A.value }
        'QWord' { [int64]$A.value }
        'MultiString' { [string[]]@($A.value) }
        'Binary' { [Convert]::FromBase64String([string]$A.value) }
        default { [string]$A.value }
      }
      New-ItemProperty -LiteralPath $path -Name ([string]$A.name) -Value $value -PropertyType $kind -Force | Out-Null
      Out-Result @{ set = $true; key = [string]$A.key; name = [string]$A.name; type = $kind.ToLower() }
    }
    'environment' {
      $scope = if ($A.scope -eq 'machine') { 'Machine' } else { 'User' }
      $value = if ($A.delete) { $null } else { [string]$A.value }
      [Environment]::SetEnvironmentVariable([string]$A.name, $value, $scope)
      Out-Result @{ name = [string]$A.name; scope = $scope.ToLower(); set = (-not $A.delete); note = 'programs started from now on see it; running ones keep what they had' }
    }
    'time_zone' {
      try { $zone = [TimeZoneInfo]::FindSystemTimeZoneById([string]$A.value) } catch { Out-Refusal "there is no time zone '$($A.value)' — read_settings area 'time' shows the current one's id"; return }
      Set-TimeZone -Id $zone.Id
      Out-Result @{ time_zone = $zone.Id; display_name = $zone.DisplayName }
    }
  }
} catch {
  if (Test-Denied $_) { Out-Refusal "that change needs an administrator, and JaiRA is not running as one — run JaiRA as administrator, or make it yourself"; return }
  throw
}
`;

const READ_CLIPBOARD = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$result = @{}
if ([Windows.Forms.Clipboard]::ContainsText()) { $result.text = [Windows.Forms.Clipboard]::GetText() }
if ([Windows.Forms.Clipboard]::ContainsFileDropList()) { $result.files = @([Windows.Forms.Clipboard]::GetFileDropList()) }
if ([Windows.Forms.Clipboard]::ContainsImage()) {
  $image = [Windows.Forms.Clipboard]::GetImage()
  if ($image) {
    $image.Save([string]$A.imageFile, [System.Drawing.Imaging.ImageFormat]::Png)
    $result.image = @{ width = $image.Width; height = $image.Height }
    $image.Dispose()
  }
}
Out-Result $result
`;

const WRITE_CLIPBOARD = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if ($A.imageFile) {
  $image = [System.Drawing.Image]::FromFile([string]$A.imageFile)
  [Windows.Forms.Clipboard]::SetImage($image)
  $image.Dispose()
} elseif ($A.files) {
  $list = New-Object System.Collections.Specialized.StringCollection
  foreach ($f in @($A.files)) { [void]$list.Add([string]$f) }
  [Windows.Forms.Clipboard]::SetFileDropList($list)
} elseif ([string]$A.text -eq '') {
  [Windows.Forms.Clipboard]::Clear()
} else {
  [Windows.Forms.Clipboard]::SetText([string]$A.text)
}
Out-Result @{ ok = $true }
`;

const WINDOWS = `
${DESK_TYPE}
${DPI_AWARE}
$names = @{}
foreach ($p in Get-Process) { $names[$p.Id] = $p.ProcessName }
$rows = foreach ($line in [JairaDesk]::List()) {
  $f = $line -split '\\|', 9
  @{ window_id = [long]$f[0]; pid = [int]$f[1]; focused = ($f[2] -eq '1'); minimized = ($f[3] -eq '1'); bounds = @{ x = [int]$f[4]; y = [int]$f[5]; width = [int]$f[6]; height = [int]$f[7] }; title = $f[8]; app = [string]$names[[int]$f[1]] }
}
Out-Result @($rows)
`;

const LAUNCH = `
switch ([string]$A.action) {
  'launch' {
    $p = Start-Process -FilePath ([string]$A.app) -PassThru
    Out-Result @{ launched = [string]$A.app; pid = $p.Id }
  }
  'open' {
    if ($A.app) {
      $p = Start-Process -FilePath ([string]$A.app) -ArgumentList ('"' + ([string]$A.target).Replace('"', '') + '"') -PassThru
      Out-Result @{ opened = [string]$A.target; with = [string]$A.app; pid = $p.Id }
    } else {
      Start-Process -FilePath ([string]$A.target)
      Out-Result @{ opened = [string]$A.target }
    }
  }
}
`;

const WINDOW_ACTION = `
${DESK_TYPE}
switch ([string]$A.action) {
  'focus' {
    if (-not [JairaDesk]::Exists([long]$A.windowId)) { Out-Refusal "there is no window $($A.windowId) — list_windows lists them"; return }
    Out-Result @{ focused = [JairaDesk]::Focus([long]$A.windowId) }
  }
  'close' {
    if (-not [JairaDesk]::Exists([long]$A.windowId)) { Out-Refusal "there is no window $($A.windowId) — list_windows lists them"; return }
    Out-Result @{ asked_to_close = [JairaDesk]::Close([long]$A.windowId) }
  }
}
`;

const WINDOW_PID = `
${DESK_TYPE}
Out-Result @{ pid = [JairaDesk]::PidOf([long]$A.windowId); exists = [JairaDesk]::Exists([long]$A.windowId) }
`;

const SCREENSHOT = `
${DESK_TYPE}
${DPI_AWARE}
Add-Type -AssemblyName System.Windows.Forms
$x = 0; $y = 0
if ($A.windowId) {
  if (-not [JairaDesk]::Exists([long]$A.windowId)) { Out-Refusal "there is no window $($A.windowId) — list_windows lists them"; return }
  $shot = [JairaDesk]::Window([long]$A.windowId, [ref]$x, [ref]$y)
  if (-not $shot) { Out-Refusal "window $($A.windowId) would not draw itself — take the screen instead"; return }
} else {
  $screens = [Windows.Forms.Screen]::AllScreens
  $screen = if ($null -ne $A.display) { if ([int]$A.display -ge $screens.Length) { Out-Refusal "there are $($screens.Length) displays, numbered from 0"; return }; $screens[[int]$A.display] } else { [Windows.Forms.Screen]::PrimaryScreen }
  $b = $screen.Bounds
  $x = $b.X; $y = $b.Y
  $shot = [JairaDesk]::Screen($b.X, $b.Y, $b.Width, $b.Height)
}
$w = 0; $h = 0
$full = @{ width = $shot.Width; height = $shot.Height }
$png = [JairaDesk]::Png($shot, [int]$A.maxSide, [ref]$w, [ref]$h)
$shot.Dispose()
[System.IO.File]::WriteAllBytes([string]$A.file, $png)
Out-Result @{ width = $w; height = $h; screen_width = $full.width; screen_height = $full.height; x = $x; y = $y }
`;

/**
 * Input through \`SendInput\`, one step at a time in the order given — the computer-use action set,
 * in the screen's own pixels (the tool has already turned a picture's coordinates into these).
 */
const INPUT = `
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
public static class JairaInput {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static void Aware() { try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { } try { SetProcessDPIAware(); } catch { } }

  static uint PidOf(IntPtr h) { if (h == IntPtr.Zero) return 0; IntPtr root = GetAncestor(h, 2); uint pid; GetWindowThreadProcessId(root == IntPtr.Zero ? h : root, out pid); return pid; }
  /** The program whose window is at a point of the screen. */
  public static uint PidAt(int x, int y) { POINT p; p.X = x; p.Y = y; return PidOf(WindowFromPoint(p)); }
  /** The program whose window has the keyboard. */
  public static uint FocusedPid() { return PidOf(GetForegroundWindow()); }

  static void Send(INPUT[] inputs) {
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length) throw new Exception("Windows refused the input (another program, or a window running as administrator, may be blocking it)");
  }
  static INPUT Mouse(uint flags, uint data) { var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; return i; }
  static INPUT Key(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }

  public static void Move(int x, int y) { SetCursorPos(x, y); Thread.Sleep(30); }
  public static void Button(string which, bool down) {
    uint flag = which == "right" ? (down ? 0x0008u : 0x0010u) : which == "middle" ? (down ? 0x0020u : 0x0040u) : (down ? 0x0002u : 0x0004u);
    Send(new[] { Mouse(flag, 0) });
  }
  public static void Click(string which, int times) {
    for (int i = 0; i < times; i++) { Button(which, true); Button(which, false); Thread.Sleep(40); }
  }
  /** Wheel notches: up and left positive, as Windows counts them. */
  public static void Scroll(bool horizontal, int notches) { Send(new[] { Mouse(horizontal ? 0x01000u : 0x0800u, (uint)(notches * 120)) }); }
  public static void Type(string text) {
    var inputs = new List<INPUT>();
    foreach (char c in text) {
      if (c == '\\n') { inputs.Add(Key(0x0D, 0, 0)); inputs.Add(Key(0x0D, 0, 2)); continue; }
      if (c == '\\t') { inputs.Add(Key(0x09, 0, 0)); inputs.Add(Key(0x09, 0, 2)); continue; }
      if (c == '\\r') continue;
      inputs.Add(Key(0, c, 0x0004)); inputs.Add(Key(0, c, 0x0004 | 0x0002));
    }
    for (int at = 0; at < inputs.Count; at += 64) { Send(inputs.GetRange(at, Math.Min(64, inputs.Count - at)).ToArray()); Thread.Sleep(10); }
  }
  static bool Extended(ushort vk) { return vk == 0x21 || vk == 0x22 || vk == 0x23 || vk == 0x24 || vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x28 || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0xA3 || vk == 0xA5; }
  public static void Keys(ushort[] chord, bool down, bool up) {
    var inputs = new List<INPUT>();
    if (down) foreach (var vk in chord) inputs.Add(Key(vk, 0, Extended(vk) ? 1u : 0u));
    if (up) for (int i = chord.Length - 1; i >= 0; i--) inputs.Add(Key(chord[i], 0, (Extended(chord[i]) ? 1u : 0u) | 2u));
    if (inputs.Count > 0) Send(inputs.ToArray());
  }
}
'@
[JairaInput]::Aware()
$named = @{
  'enter' = 0x0D; 'return' = 0x0D; 'tab' = 0x09; 'escape' = 0x1B; 'esc' = 0x1B; 'space' = 0x20; 'backspace' = 0x08; 'delete' = 0x2E; 'del' = 0x2E; 'insert' = 0x2D
  'home' = 0x24; 'end' = 0x23; 'page_up' = 0x21; 'pageup' = 0x21; 'prior' = 0x21; 'page_down' = 0x22; 'pagedown' = 0x22; 'next' = 0x22
  'left' = 0x25; 'up' = 0x26; 'right' = 0x27; 'down' = 0x28
  'ctrl' = 0x11; 'control' = 0x11; 'shift' = 0x10; 'alt' = 0x12; 'option' = 0x12; 'super' = 0x5B; 'win' = 0x5B; 'windows' = 0x5B; 'cmd' = 0x5B; 'meta' = 0x5B
  'capslock' = 0x14; 'caps_lock' = 0x14; 'printscreen' = 0x2C; 'print' = 0x2C; 'menu' = 0x5D; 'apps' = 0x5D; 'pause' = 0x13
  'minus' = 0xBD; 'plus' = 0xBB; 'equal' = 0xBB; 'comma' = 0xBC; 'period' = 0xBE; 'slash' = 0xBF; 'semicolon' = 0xBA; 'apostrophe' = 0xDE; 'quote' = 0xDE; 'bracketleft' = 0xDB; 'bracketright' = 0xDD; 'backslash' = 0xDC; 'grave' = 0xC0
  '-' = 0xBD; '=' = 0xBB; ',' = 0xBC; '.' = 0xBE; '/' = 0xBF; ';' = 0xBA; "'" = 0xDE; '[' = 0xDB; ']' = 0xDD; '\\' = 0xDC; '\`' = 0xC0
}
function Chord([string]$keys) {
  $codes = foreach ($part in ($keys -split '\\+')) {
    $k = $part.Trim().ToLower()
    if ($named.ContainsKey($k)) { [uint16]$named[$k] }
    elseif ($k -match '^f([1-9]|1[0-9]|2[0-4])$') { [uint16](0x70 + [int]$matches[1] - 1) }
    elseif ($k -match '^[a-z0-9]$') { [uint16][char]$k.ToUpper() }
    else { throw "'$part' is not a key this knows — use a letter, a digit, a name like enter, tab, escape, f5, page_down, or a modifier ctrl, shift, alt, super" }
  }
  return [uint16[]]@($codes)
}
$guarded = @($A.protected | ForEach-Object { [int]$_ })
# JaiRA's own windows take no input from an agent — a click there could answer the agent's own approval.
function Refused([uint32]$owner, [string]$what) {
  if ($guarded -contains [int]$owner) { Out-Refusal "refused: $what JaiRA's own window — an agent may not click or type into JaiRA. Focus another window first (open_app focus)"; return $true }
  return $false
}
function Here() { $p = New-Object JairaInput+POINT; [void][JairaInput]::GetCursorPos([ref]$p); return $p }
foreach ($step in @($A.steps)) {
  $at = if ($null -ne $step.x) { @{ x = [int]$step.x; y = [int]$step.y } } else { $h = Here; @{ x = $h.X; y = $h.Y } }
  switch -regex ([string]$step.action) {
    '^(left_click|right_click|middle_click|double_click|triple_click|left_mouse_down|scroll)$' { if (Refused ([JairaInput]::PidAt($at.x, $at.y)) 'that point is on') { return } }
    '^left_click_drag$' { if ((Refused ([JairaInput]::PidAt([int]$step.from.x, [int]$step.from.y)) 'the drag starts on') -or (Refused ([JairaInput]::PidAt([int]$step.x, [int]$step.y)) 'the drag ends on')) { return } }
    '^(type|key|hold_key)$' { if (Refused ([JairaInput]::FocusedPid()) 'the keyboard is in') { return } }
  }
  switch ([string]$step.action) {
    'mouse_move' { [JairaInput]::Move([int]$step.x, [int]$step.y) }
    'left_click' { if ($null -ne $step.x) { [JairaInput]::Move([int]$step.x, [int]$step.y) }; if ($step.keys) { [JairaInput]::Keys((Chord $step.keys), $true, $false) }; [JairaInput]::Click('left', 1); if ($step.keys) { [JairaInput]::Keys((Chord $step.keys), $false, $true) } }
    'right_click' { if ($null -ne $step.x) { [JairaInput]::Move([int]$step.x, [int]$step.y) }; [JairaInput]::Click('right', 1) }
    'middle_click' { if ($null -ne $step.x) { [JairaInput]::Move([int]$step.x, [int]$step.y) }; [JairaInput]::Click('middle', 1) }
    'double_click' { if ($null -ne $step.x) { [JairaInput]::Move([int]$step.x, [int]$step.y) }; [JairaInput]::Click('left', 2) }
    'triple_click' { if ($null -ne $step.x) { [JairaInput]::Move([int]$step.x, [int]$step.y) }; [JairaInput]::Click('left', 3) }
    'left_mouse_down' { [JairaInput]::Button('left', $true) }
    'left_mouse_up' { [JairaInput]::Button('left', $false) }
    'left_click_drag' {
      [JairaInput]::Move([int]$step.from.x, [int]$step.from.y); [JairaInput]::Button('left', $true); Start-Sleep -Milliseconds 80
      [JairaInput]::Move([int]$step.x, [int]$step.y); Start-Sleep -Milliseconds 80; [JairaInput]::Button('left', $false)
    }
    'scroll' {
      if ($null -ne $step.x) { [JairaInput]::Move([int]$step.x, [int]$step.y) }
      $n = [int]$step.amount
      switch ([string]$step.direction) { 'up' { [JairaInput]::Scroll($false, $n) } 'down' { [JairaInput]::Scroll($false, -$n) } 'left' { [JairaInput]::Scroll($true, -$n) } 'right' { [JairaInput]::Scroll($true, $n) } }
    }
    'type' { [JairaInput]::Type([string]$step.text) }
    'key' { $c = Chord ([string]$step.keys); [JairaInput]::Keys($c, $true, $true) }
    'hold_key' { $c = Chord ([string]$step.keys); [JairaInput]::Keys($c, $true, $false); Start-Sleep -Milliseconds ([int]([double]$step.seconds * 1000)); [JairaInput]::Keys($c, $false, $true) }
    'wait' { Start-Sleep -Milliseconds ([int]([double]$step.seconds * 1000)) }
    'cursor_position' { }
  }
  Start-Sleep -Milliseconds 50
}
$p = New-Object JairaInput+POINT
[void][JairaInput]::GetCursorPos([ref]$p)
Out-Result @{ cursor = @{ x = $p.X; y = $p.Y } }
`;

/** A registry key as the provider reads one: `HKCU\\Software\\X` (or `HKEY_CURRENT_USER\\…`, `HKCU:\\…`) → `Registry::HKEY_CURRENT_USER\\Software\\X`. */
export function registryPath(key: string): string {
  const hives: Record<string, string> = {
    hklm: "HKEY_LOCAL_MACHINE",
    hkey_local_machine: "HKEY_LOCAL_MACHINE",
    hkcu: "HKEY_CURRENT_USER",
    hkey_current_user: "HKEY_CURRENT_USER",
    hkcr: "HKEY_CLASSES_ROOT",
    hkey_classes_root: "HKEY_CLASSES_ROOT",
    hku: "HKEY_USERS",
    hkey_users: "HKEY_USERS",
    hkcc: "HKEY_CURRENT_CONFIG",
    hkey_current_config: "HKEY_CURRENT_CONFIG",
  };
  const trimmed = key.trim().replace(/^registry::/i, "").replace(/\//g, "\\");
  const match = /^([a-z_]+):?(?:\\(.*))?$/i.exec(trimmed);
  const hive = match !== null ? hives[match[1]!.toLowerCase()] : undefined;
  if (match === null || hive === undefined) throw new SystemToolRefusal(`'${key}' is not a registry key — start it with a hive: HKCU\\…, HKLM\\…, HKCR\\…, HKU\\… or HKCC\\…`);
  const rest = (match[2] ?? "").replace(/\\+$/, "");
  return `Registry::${hive}${rest.length > 0 ? `\\${rest}` : ""}`;
}

/** The last lines a program wrote, without the progress bars it redraws with carriage returns. */
function tailOf(text: string, lines = 40): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.slice(line.lastIndexOf("\r") + 1).replace(/[\u2580-\u259f\u2800-\u28ff]/g, "").trimEnd())
    .filter((line) => line.trim().length > 0 && !/^[-\\|/\s]+$/.test(line))
    .slice(-lines)
    .join("\n");
}

/** Run a program to its end with arguments as an array — never a command line. */
function runProgram(program: string, args: readonly string[], timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, [...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout!.on("data", (c: Buffer) => chunks.push(c));
    child.stderr!.on("data", (c: Buffer) => chunks.push(c));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${program} did not finish within ${Math.round(timeoutMs / 60_000)} min`));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject((e as NodeJS.ErrnoException).code === "ENOENT" ? new SystemToolRefusal(`${program} is not installed on this machine`) : e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

/** A scratch file for a script to write into, removed after. */
function withScratch<T>(name: string, use: (file: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "jaira-system-"));
  return use(join(dir, name)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

export class WindowsSystem implements SystemBackend {
  readonly os = "windows" as const;

  readSystem(about: SystemAbout, log: LogQuery): Promise<JsonValue> {
    return ps<JsonValue>(READ_SYSTEM, { about, ...log });
  }

  async power(action: PowerAction, delaySeconds: number): Promise<JsonValue> {
    const delay = String(Math.max(0, Math.min(315_360_000, Math.round(delaySeconds))));
    const run = async (args: string[], what: string): Promise<JsonValue> => {
      const { code, output } = await runProgram("shutdown.exe", args, 30_000);
      if (code !== 0) throw new Error(`shutdown.exe ${args.join(" ")} failed (${code}): ${tailOf(output, 3)}`);
      return { done: what };
    };
    switch (action) {
      case "restart":
        return run(["/r", "/t", delay, "/c", "Restarted by an agent through JaiRA"], `restarting in ${delay} s — 'cancel' stops it until then`);
      case "shut_down":
        return run(["/s", "/t", delay, "/c", "Shut down by an agent through JaiRA"], `shutting down in ${delay} s — 'cancel' stops it until then`);
      case "sign_out":
        return run(["/l"], "signing out");
      case "cancel":
        return run(["/a"], "the pending restart or shut-down is cancelled");
      case "lock": {
        const { code } = await runProgram("rundll32.exe", ["user32.dll,LockWorkStation"], 15_000);
        if (code !== 0) throw new Error(`locking failed (${code})`);
        return { done: "locked" };
      }
      case "sleep":
      case "hibernate": {
        // Suspending returns only on waking, so it is started apart from this call, a moment later.
        const state = action === "sleep" ? "Suspend" : "Hibernate";
        const script = `Start-Sleep -Seconds 2; Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::${state}, $false, $false)`;
        const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, detached: true, stdio: "ignore" });
        child.unref();
        return { done: action === "sleep" ? "going to sleep in a moment" : "hibernating in a moment" };
      }
    }
  }

  async processes(): Promise<ProcessRow[]> {
    return listOf<ProcessRow>(await ps(PROCESSES, null));
  }

  stopProcess(pid: number, options: { started?: string; tree: boolean; force: boolean }): Promise<{ stopped: boolean; how: string }> {
    return ps(STOP_PROCESS, { pid, started: options.started ?? null, tree: options.tree, force: options.force });
  }

  async services(): Promise<ServiceRow[]> {
    return listOf<ServiceRow>(await ps(SERVICES, null));
  }

  controlService(name: string, action: ServiceAction, startType?: StartType): Promise<ServiceRow> {
    return ps(CONTROL_SERVICE, { name, action, startType: startType ?? null }, { timeoutMs: 90_000 });
  }

  async software(kind: SoftwareKind): Promise<SoftwareRow[]> {
    if (kind === "packages") {
      // What winget knows of what is installed, by the id `install_software` takes.
      return withScratch("packages.json", async (file) => {
        const { code, output } = await runProgram("winget", ["export", "-o", file, "--accept-source-agreements", "--disable-interactivity"], 180_000);
        let parsed: { Sources?: Array<{ SourceDetails?: { Name?: string }; Packages?: Array<{ PackageIdentifier?: string; Version?: string }> }> };
        try {
          parsed = JSON.parse(readFileSync(file, "utf8"));
        } catch {
          throw new Error(`winget export failed (${code}): ${tailOf(output, 3)}`);
        }
        return (parsed.Sources ?? []).flatMap((source) =>
          (source.Packages ?? []).flatMap((p) => (p.PackageIdentifier !== undefined ? [{ name: p.PackageIdentifier, id: p.PackageIdentifier, ...(p.Version !== undefined ? { version: p.Version } : {}), ...(source.SourceDetails?.Name !== undefined ? { publisher: source.SourceDetails.Name } : {}), kind: "package" as const }] : [])),
        );
      });
    }
    return listOf<SoftwareRow>(await ps(SOFTWARE, { kind }, { timeoutMs: 120_000 }));
  }

  async installSoftware(request: InstallRequest, timeoutMs: number): Promise<InstallResult> {
    if (request.manager === "powershell") {
      const script = `
if (-not (Get-PackageProvider -ListAvailable -Name NuGet -ErrorAction SilentlyContinue)) { Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser | Out-Null }
$out = switch ([string]$A.action) {
  'install' { if ($A.version) { Install-Module -Name ([string]$A.id) -RequiredVersion ([string]$A.version) -Scope CurrentUser -Force -AllowClobber -ErrorAction Stop } else { Install-Module -Name ([string]$A.id) -Scope CurrentUser -Force -AllowClobber -ErrorAction Stop } }
  'uninstall' { Uninstall-Module -Name ([string]$A.id) -AllVersions -Force -ErrorAction Stop }
  'upgrade' { Update-Module -Name ([string]$A.id) -Force -ErrorAction Stop }
}
$now = @(Get-InstalledModule -Name ([string]$A.id) -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Name) $($_.Version)" })
Out-Result @{ exit_code = 0; output = $(if ($now.Count -gt 0) { 'installed now: ' + ($now -join ', ') } else { 'not installed now' }) }
`;
      return ps<InstallResult>(script, request, { timeoutMs });
    }
    if (request.manager !== "winget") throw new SystemToolRefusal(`'${request.manager}' is not a package manager on Windows — use winget, or powershell for a PowerShell module`);
    const common = ["--id", request.id, "--exact", "--silent", "--disable-interactivity"];
    const agree = ["--accept-package-agreements", "--accept-source-agreements"];
    const args =
      request.action === "install"
        ? ["install", ...common, ...agree, ...(request.version !== undefined ? ["--version", request.version] : [])]
        : request.action === "upgrade"
          ? ["upgrade", ...common, ...agree]
          : ["uninstall", ...common, "--accept-source-agreements"];
    const { code, output } = await runProgram("winget", args, timeoutMs);
    return { exit_code: code, output: tailOf(output) };
  }

  readSettings(request: ReadSettingsRequest): Promise<JsonValue> {
    if (request.area === "defaults") throw new SystemToolRefusal("'defaults' are macOS' — on Windows a program's settings are in the registry: area 'registry'");
    if (request.area === "registry" && request.key === undefined) throw new SystemToolRefusal("name the registry key: `key`, like HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer");
    return ps<JsonValue>(READ_SETTINGS, { ...request, ...(request.area === "registry" ? { path: registryPath(request.key!) } : {}) });
  }

  writeSettings(request: WriteSettingsRequest): Promise<JsonValue> {
    if (request.area === "defaults") throw new SystemToolRefusal("'defaults' are macOS' — on Windows a program's settings are in the registry: area 'registry'");
    if (request.area === "registry" && request.key === undefined) throw new SystemToolRefusal("name the registry key: `key`");
    return ps<JsonValue>(WRITE_SETTINGS, { ...request, ...(request.area === "registry" ? { path: registryPath(request.key!) } : {}) });
  }

  async readClipboard(): Promise<ClipboardContent> {
    return withScratch("clipboard.png", async (imageFile) => {
      const read = await ps<{ text?: string; files?: string[] | string; image?: { width: number; height: number } }>(READ_CLIPBOARD, { imageFile });
      return {
        ...(read.text !== undefined ? { text: read.text } : {}),
        ...(read.files !== undefined ? { files: listOf<string>(read.files) } : {}),
        ...(read.image !== undefined ? { image: { png: readFileSync(imageFile), width: read.image.width, height: read.image.height } } : {}),
      };
    });
  }

  async writeClipboard(write: ClipboardWrite): Promise<void> {
    await ps(WRITE_CLIPBOARD, write);
  }

  async windows(): Promise<WindowRow[]> {
    return listOf<WindowRow>(await ps(WINDOWS, null));
  }

  /** The program a window belongs to, and whether it is still there. */
  windowOwner(windowId: number): Promise<{ pid: number; exists: boolean }> {
    return ps(WINDOW_PID, { windowId });
  }

  openApp(request: OpenRequest): Promise<JsonValue> {
    return ps<JsonValue>(request.action === "launch" || request.action === "open" ? LAUNCH : WINDOW_ACTION, request);
  }

  async screenshot(request: ScreenshotRequest): Promise<ScreenPicture> {
    return withScratch("screen.png", async (file) => {
      const shot = await ps<{ width: number; height: number; screen_width: number; screen_height: number; x: number; y: number }>(SCREENSHOT, { ...request, file });
      return { png: readFileSync(file), width: shot.width, height: shot.height, region: { x: shot.x, y: shot.y, width: shot.screen_width, height: shot.screen_height } };
    });
  }

  input(steps: readonly InputStep[], guarded: readonly number[], signal?: AbortSignal): Promise<{ cursor?: { x: number; y: number } }> {
    const seconds = steps.reduce((sum, step) => sum + ("seconds" in step ? step.seconds : 0), 0);
    return ps(INPUT, { steps, protected: guarded }, { timeoutMs: 30_000 + seconds * 1000, ...(signal !== undefined ? { signal } : {}) });
  }
}
