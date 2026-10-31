import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * How the plugin's privileges compare to the running Steam client's:
 * - `steam-elevated`: Steam runs as administrator and Stream Deck does not.
 * - `plugin-elevated`: Stream Deck runs as administrator and Steam does not.
 * - `match`: both run the same way.
 * - `unknown`: it could not be told, Steam not running, not Windows, or the check failed.
 *
 * A mismatch either way makes Windows drop the launch request between the two without an error.
 */
export type ElevationMismatch = "steam-elevated" | "plugin-elevated" | "match" | "unknown";

/**
 * Reads each process's elevation straight from its token. A token the plugin is not even allowed
 * to open belongs to a process running above it, which is the case being looked for.
 * `$PID` is PowerShell's own, which runs with the plugin's token since it is the plugin's child.
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace SteamHub -Name Win -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
[DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
[DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr token, int cls, out int value, int length, out int returned);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
'@
function Get-Elevation([uint32]$id) {
  $process = [SteamHub.Win]::OpenProcess(0x1000, $false, $id)
  if ($process -eq [IntPtr]::Zero) {
    if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 5) { return 'denied' }
    return 'gone'
  }
  try {
    $token = [IntPtr]::Zero
    if (-not [SteamHub.Win]::OpenProcessToken($process, 8, [ref]$token)) {
      if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 5) { return 'denied' }
      return 'unknown'
    }
    try {
      $value = 0; $returned = 0
      if (-not [SteamHub.Win]::GetTokenInformation($token, 20, [ref]$value, 4, [ref]$returned)) { return 'unknown' }
      if ($value -ne 0) { return 'yes' }
      return 'no'
    } finally { [void][SteamHub.Win]::CloseHandle($token) }
  } finally { [void][SteamHub.Win]::CloseHandle($process) }
}
"self=$(Get-Elevation $PID) steam=$(Get-Elevation STEAM_PID)"
`;

/**
 * Compares the plugin's privileges with the running Steam client's.
 *
 * Starts PowerShell and compiles a few lines of interop, so it takes a second or two: only meant
 * for working out why a launch was lost, never for every launch.
 * @param steamPid Process id of the running Steam client.
 * @returns How the two compare.
 */
export async function checkElevation(steamPid: number): Promise<ElevationMismatch> {
  if (process.platform !== "win32" || !Number.isSafeInteger(steamPid) || steamPid <= 0) {
    return "unknown";
  }

  try {
    // Encoded, so the script reaches PowerShell untouched by command-line quoting.
    const encoded = Buffer.from(SCRIPT.replace("STEAM_PID", String(steamPid)), "utf16le").toString("base64");
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 15_000 },
    );

    const match = /self=(\w+) steam=(\w+)/.exec(stdout);
    if (match === null) {
      return "unknown";
    }

    const [, self, steam] = match;
    if (self === "no" && (steam === "yes" || steam === "denied")) {
      return "steam-elevated";
    }
    if (self === "yes" && steam === "no") {
      return "plugin-elevated";
    }
    if (self === steam && (self === "yes" || self === "no")) {
      return "match";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}
