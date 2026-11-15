# Enumerate existing SMB Previous Versions. Never creates snapshots or opens databases.
# Protocol: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-smb2/c631e497-9a47-4537-9817-8af2a4834d03
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This probe requires Windows and an existing SMB connection.' }

# Do not resolve through provider paths or traverse the profile. Only a mapped SMB
# drive or UNC directory is accepted. Authentication uses the existing connection.
$uncPath = $Path.TrimEnd('\')
if ($uncPath -match '^([A-Za-z]:)\\(.*)$') {
    $driveName = $Matches[1]
    $relativePath = $Matches[2]
    $mapping = Get-SmbMapping -LocalPath $driveName -ErrorAction Stop
    if (-not $mapping.RemotePath) { throw 'The drive is not an SMB mapping.' }
    $uncPath = $mapping.RemotePath.TrimEnd('\') + '\' + $relativePath
}
if ($uncPath -notmatch '^\\\\([^\\]+)\\([^\\]+)(\\.*)?$' -or $uncPath -match '(^|\\)\.\.?($|\\)' -or $uncPath.Contains('@GMT-')) {
    throw 'Supply a current SMB directory, without dot segments or an existing @GMT token.'
}
$shareRoot = '\\' + $Matches[1] + '\' + $Matches[2]
$shareRelative = $Matches[3]

if (-not ('SnsBox.SmbPreviousVersions' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace SnsBox {
    public static class SmbPreviousVersions {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
            IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool DeviceIoControl(SafeFileHandle handle, uint code,
            IntPtr input, uint inputSize, byte[] output, uint outputSize,
            out uint returned, IntPtr overlapped);

        public static string[] Read(string path) {
            // GENERIC_READ, share READ|WRITE|DELETE, OPEN_EXISTING,
            // FILE_FLAG_BACKUP_SEMANTICS (open a directory). No write access.
            using (var handle = CreateFileW(path, 0x80000000, 7, IntPtr.Zero, 3,
                                           0x02000000, IntPtr.Zero)) {
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                // Bounded response, no retries against a changing source.
                var buffer = new byte[1048576];
                uint returned;
                if (!DeviceIoControl(handle, 0x00144064, IntPtr.Zero, 0,
                    buffer, (uint)buffer.Length, out returned, IntPtr.Zero))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if (returned < 12 || returned > buffer.Length)
                    throw new InvalidOperationException("Invalid snapshot response.");
                uint total = BitConverter.ToUInt32(buffer, 0);
                uint count = BitConverter.ToUInt32(buffer, 4);
                uint size = BitConverter.ToUInt32(buffer, 8);
                if (total == 0 && count == 0) return new string[0];
                if (count != total || size > returned - 12 || size % 2 != 0)
                    throw new InvalidOperationException("Incomplete snapshot response.");
                var entries = Encoding.Unicode.GetString(buffer, 12, (int)size)
                    .Split(new char[] { '\0' }, StringSplitOptions.RemoveEmptyEntries);
                if (entries.Length != count)
                    throw new InvalidOperationException("Invalid snapshot count.");
                foreach (var entry in entries) {
                    if (!System.Text.RegularExpressions.Regex.IsMatch(entry,
                        @"^@GMT-\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}$"))
                        throw new InvalidOperationException("Invalid snapshot timestamp.");
                }
                return entries;
            }
        }
    }
}
'@
}

try {
    $versions = @([SnsBox.SmbPreviousVersions]::Read($uncPath))
    $result = [ordered]@{
        status = $(if ($versions.Count) { 'available' } else { 'none_advertised' })
        readOnly = $true
        createsSnapshot = $false
        snapshots = @($versions | ForEach-Object {
            @{ timestamp = $_; path = $shareRoot + '\' + $_ + $shareRelative }
        })
        # Enumeration is discovery, not proof of database completeness or keys.
        confirmedConsistentSnapshot = $false
    }
} catch {
    $cause = $_.Exception
    while ($cause.InnerException) { $cause = $cause.InnerException }
    $nativeCode = if ($cause -is [System.ComponentModel.Win32Exception]) { $cause.NativeErrorCode } else { $null }
    $result = [ordered]@{
        status = $(if ($nativeCode -in @(1, 50)) { 'unsupported' } elseif ($nativeCode -eq 5) { 'access_denied' } else { 'probe_failed' })
        readOnly = $true
        createsSnapshot = $false
        snapshots = @()
        confirmedConsistentSnapshot = $false
        nativeError = $nativeCode
    }
}
$result | ConvertTo-Json -Depth 4
