param(
  [Parameter(Mandatory = $true)][string]$ArchivePath,
  [string]$Destination = (Join-Path $PSScriptRoot '../resources/creative-workbench/v2.5.2')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $ArchivePath).Path)
try {
  $rootEntry = '智能體創作工作台/'
  $reader = [IO.StreamReader]::new($archive.GetEntry($rootEntry + 'SHA256SUMS.json').Open())
  try { $checksums = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
  $targetRoot = [IO.Path]::GetFullPath($Destination)
  $entries = @($archive.Entries | Where-Object { $_.Name })
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $total = 0L
  # Validate every path and digest before writing anything. Never execute package scripts.
  foreach ($entry in $entries) {
    if (!$entry.FullName.StartsWith($rootEntry)) { throw 'Unexpected archive root' }
    $relative = $entry.FullName.Substring($rootEntry.Length)
    if ($relative.Contains('\') -or $relative.Contains(':') -or $relative.Split('/') -contains '..') { throw "Unsafe archive path: $relative" }
    $target = [IO.Path]::GetFullPath((Join-Path $targetRoot $relative))
    if (!$target.StartsWith($targetRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or !$seen.Add($target)) { throw "Unsafe or duplicate path: $relative" }
    if (Test-Path -LiteralPath $target) { throw "Refusing to overwrite: $target" }
    $total += $entry.Length
    if ($entry.Length -gt 8MB -or $total -gt 32MB -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Unsafe archive entry' }
    if ($relative -ne 'SHA256SUMS.json') {
      $expected = $checksums.PSObject.Properties[$relative].Value
      if (!$expected) { throw "Missing checksum: $relative" }
      $sha = [Security.Cryptography.SHA256]::Create(); $stream = $entry.Open()
      try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $stream.Dispose(); $sha.Dispose() }
      if ($actual -ne $expected) { throw "Checksum mismatch: $relative" }
    }
  }
  foreach ($entry in $entries) {
    $target = Join-Path $targetRoot $entry.FullName.Substring($rootEntry.Length)
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
  }
  "Imported $($entries.Count) verified files ($total bytes) into $targetRoot"
} finally { $archive.Dispose() }
