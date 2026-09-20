# Verified versioned per-user CLI + Office install. No administrator privileges or PATH mutation.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Version,
  [switch]$Yes,
  [switch]$DesktopShortcut
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$') { throw 'Invalid release version without leading v' }
if ($env:OS -ne 'Windows_NT' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'This installer requires Windows x64' }
$Destination = Join-Path $env:LOCALAPPDATA "YCoding\versions\$Version"
$Shortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) "YCoding Office $Version.lnk"
if (-not $Yes) { Write-Output "Preview: install verified CLI + Office into $Destination. Repeat with -Yes to write files. No PATH edit."; exit 0 }
if (Test-Path -LiteralPath $Destination) { throw 'Destination exists. This versioned installer never overwrites an installed version.' }
if ($DesktopShortcut -and (Test-Path -LiteralPath $Shortcut)) { throw 'Shortcut already exists; review it manually.' }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Temp = Join-Path ([IO.Path]::GetTempPath()) ('ycoding-office-' + [Guid]::NewGuid().ToString('N'))
$Installed = $false
$ShortcutCreated = $false
try {
  New-Item -ItemType Directory -Path $Temp | Out-Null
  $Base = "https://github.com/Althenia/ycoding/releases/download/v$Version"
  $Manifest = Join-Path $Temp 'checksums.txt'
  Invoke-WebRequest -UseBasicParsing -Uri "$Base/ycoding-$Version-checksums.txt" -OutFile $Manifest
  $Hashes = @{}
  foreach ($Line in Get-Content -LiteralPath $Manifest) {
    if ($Line.Trim().Length -eq 0) { continue }
    if ($Line -notmatch '^([a-fA-F0-9]{64}) [ *]([A-Za-z0-9._+-]+)$') { throw 'Invalid checksum manifest' }
    if ($Hashes.ContainsKey($Matches[2])) { throw 'Duplicate checksum entry' }
    $Hashes[$Matches[2]] = $Matches[1].ToLowerInvariant()
  }
  $Parent = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Path $Parent -Force | Out-Null
  # Stage on the destination volume, so the directory move is atomic.
  $Stage = Join-Path $Parent ('.staging-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $Stage | Out-Null
  $Packages = @(
    @{Name="ycoding-$Version-windows-x64.zip"; Files=@('ycoding.exe')},
    @{Name="ycoding-office-$Version-windows-x64.zip"; Files=@('ycoding-office.exe','ycoding-office.pck')}
  )
  foreach ($Package in $Packages) {
    $Name = $Package.Name
    if (-not $Hashes.ContainsKey($Name)) { throw "No checksum for $Name" }
    $Archive = Join-Path $Temp $Name
    Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Name" -OutFile $Archive
    if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Hashes[$Name]) { throw "Checksum mismatch: $Name" }
    $Zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
      if ($Zip.Entries.Count -ne $Package.Files.Count) { throw 'Unexpected archive entry count' }
      $Seen = @{}
      foreach ($Entry in $Zip.Entries) {
        if ($Package.Files -cnotcontains $Entry.FullName -or $Seen.ContainsKey($Entry.FullName) -or $Entry.Length -le 0) { throw 'Unsafe or duplicate archive entry' }
        if (($Entry.ExternalAttributes -band 0xF0000000) -eq 0xA0000000) { throw 'Archive symlinks are not allowed' }
        $Seen[$Entry.FullName] = $true
        $Target = Join-Path $Stage $Entry.FullName
        $InputStream=$Entry.Open(); $OutputStream=[IO.File]::Open($Target,[IO.FileMode]::CreateNew)
        try { $InputStream.CopyTo($OutputStream) } finally { $InputStream.Dispose(); $OutputStream.Dispose() }
      }
    } finally { $Zip.Dispose() }
  }
  [IO.Directory]::Move($Stage,$Destination); $Installed=$true
  if ($DesktopShortcut) {
    $Shell = New-Object -ComObject WScript.Shell
    $Link = $Shell.CreateShortcut($Shortcut)
    $Link.TargetPath = Join-Path $Destination 'ycoding-office.exe'
    $Link.WorkingDirectory = $Destination
    $Link.Save(); $ShortcutCreated=$true
  }
  Write-Output "Installed into $Destination"
  Write-Output 'The CLI is beside Office, not added to PATH. Verify service setup and the first real prompt. Signatures/SmartScreen status are documented in release notes; do not disable OS protections.'
} catch {
  if ($ShortcutCreated) { Remove-Item -LiteralPath $Shortcut -Force }
  if ($Installed) { Remove-Item -LiteralPath $Destination -Recurse -Force }
  throw
} finally {
  if ($Stage -and (Test-Path -LiteralPath $Stage)) { Remove-Item -LiteralPath $Stage -Recurse -Force }
  if (Test-Path -LiteralPath $Temp) { Remove-Item -LiteralPath $Temp -Recurse -Force }
}
