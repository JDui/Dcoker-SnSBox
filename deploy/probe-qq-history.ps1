# Bounded read-only inspection: no SQLite connection, locks, copies, or key output.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'

function Inspect-Database([string]$Directory, [string]$Name) {
    $path = Join-Path $Directory $Name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return [ordered]@{ name = $Name; status = 'missing' }
    }
    $file = Get-Item -LiteralPath $path -Force
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        return [ordered]@{ name = $Name; status = 'link_skipped' }
    }
    $stream = $null
    try {
        $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read,
            ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        $buffer = New-Object byte[] 1040
        $count = 0
        while ($count -lt $buffer.Length) {
            $read = $stream.Read($buffer, $count, $buffer.Length - $count)
            if ($read -eq 0) { break }
            $count += $read
        }
        $plain = $count -ge 16 -and [Text.Encoding]::ASCII.GetString($buffer, 0, 16).StartsWith('SQLite format 3')
        $payloadPlain = $count -ge 1040 -and [Text.Encoding]::ASCII.GetString($buffer, 1024, 16).StartsWith('SQLite format 3')
        # WeQ readKeyMeta layout; report shape only, never the credential-like value.
        $ntHeader = $count -ge 175 -and [Text.Encoding]::ASCII.GetString($buffer, 47, 128) -match '^[0-9a-fA-F]{128}$'
        $wal = Get-Item -LiteralPath ($path + '-wal') -Force -ErrorAction SilentlyContinue
        [ordered]@{
            name = $Name
            status = if ($plain) { 'plaintext_header' } elseif ($ntHeader -and -not $payloadPlain) { 'ntqq_encrypted_header' } else { 'unknown_header' }
            bytes = $stream.Length
            headerBytesRead = $count
            walPresent = $null -ne $wal
            walBytes = if ($null -ne $wal) { $wal.Length } else { 0 }
            confirmedConsistentSnapshot = $false
        }
    } catch {
        [ordered]@{ name = $Name; status = 'read_failed'; confirmedConsistentSnapshot = $false }
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $buffer) { [Array]::Clear($buffer, 0, $buffer.Length) }
    }
}

try {
    $root = Get-Item -LiteralPath $ConfigPath -Force
    if (-not $root.PSIsContainer -or ($root.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid root' }
    $qqRoot = Join-Path $root.FullName '.config/QQ'
    $qq = Get-Item -LiteralPath $qqRoot -Force
    if (-not $qq.PSIsContainer -or ($qq.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid QQ root' }
    $profiles = @(Get-ChildItem -LiteralPath $qqRoot -Directory -Force |
        Where-Object { $_.Name -like 'nt_qq_*' -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) })
    $results = @()
    foreach ($profile in $profiles) {
        $db = Get-Item -LiteralPath (Join-Path $profile.FullName 'nt_db') -Force -ErrorAction SilentlyContinue
        if ($null -eq $db -or -not $db.PSIsContainer -or ($db.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
        $results += [ordered]@{
            profile = $results.Count + 1
            databases = @(foreach ($name in @('nt_msg.db', 'group_msg_fts.db', 'profile_info.db')) { Inspect-Database $db.FullName $name })
        }
    }
    [ordered]@{
        readOnly = $true
        profileCount = $results.Count
        profiles = $results
        confirmedConsistentSnapshot = $false
        messagesRead = 0
        note = 'Header inspection only. A matching key and independent consistent source are required for encrypted history. WAL presence or a stable timestamp does not prove consistency.'
    } | ConvertTo-Json -Depth 7
} catch {
    [ordered]@{ readOnly = $true; status = 'profile_unavailable'; messagesRead = 0; confirmedConsistentSnapshot = $false } | ConvertTo-Json
    exit 2
}
