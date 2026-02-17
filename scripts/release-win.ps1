param(
  [string]$VersionTag
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PackageJsonPath = Join-Path $ProjectRoot "package.json"
$BundleRoot = Join-Path $ProjectRoot "src-tauri/target/release/bundle"
$ReleaseAssetsDir = Join-Path $ProjectRoot "release-assets"

function Get-JsonVersion {
  param([string]$Path)

  $content = Get-Content -Raw -Path $Path
  $match = [regex]::Match($content, '"version"\s*:\s*"([^"]+)"')
  if (-not $match.Success) {
    throw "Cannot find version in $Path"
  }

  return $match.Groups[1].Value
}

function Normalize-VersionTag {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    $version = Get-JsonVersion -Path $PackageJsonPath
    return "v$version"
  }

  if ($Value -match '^v\d+\.\d+\.\d+([\-+][0-9A-Za-z\.-]+)?$') {
    return $Value
  }

  if ($Value -match '^\d+\.\d+\.\d+([\-+][0-9A-Za-z\.-]+)?$') {
    return "v$Value"
  }

  throw "Invalid VersionTag '$Value'. Use v1.2.3 or 1.2.3"
}

$VersionTag = Normalize-VersionTag -Value $VersionTag

Write-Host "Release tag: $VersionTag"
Write-Host "Building Tauri app..."

Push-Location $ProjectRoot
try {
  npm run pack:win
  if ($LASTEXITCODE -ne 0) {
    throw "pack:win failed with exit code $LASTEXITCODE"
  }
}
finally {
  Pop-Location
}

New-Item -ItemType Directory -Path $ReleaseAssetsDir -Force | Out-Null

$currentVersionFiles = @(
  "Codex-Switch-$VersionTag-Windows.msi",
  "Codex-Switch-$VersionTag-Windows.msi.sig",
  "Codex-Switch-$VersionTag-Windows-Portable.zip"
)

foreach ($name in $currentVersionFiles) {
  $path = Join-Path $ReleaseAssetsDir $name
  if (Test-Path $path) {
    Remove-Item -Path $path -Force
  }
}

$msi = Get-ChildItem -Path (Join-Path $BundleRoot "msi") -Recurse -Include *.msi -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if ($null -eq $msi) {
  $msi = Get-ChildItem -Path $BundleRoot -Recurse -Include *.msi -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
}

if ($null -ne $msi) {
  $dest = "Codex-Switch-$VersionTag-Windows.msi"
  Copy-Item $msi.FullName (Join-Path $ReleaseAssetsDir $dest)
  Write-Host "Installer copied: $dest"

  $sigPath = "$($msi.FullName).sig"
  if (Test-Path $sigPath) {
    Copy-Item $sigPath (Join-Path $ReleaseAssetsDir ("$dest.sig"))
    Write-Host "Signature copied: $dest.sig"
  }
  else {
    Write-Warning "Signature not found for $($msi.Name)"
  }
}
else {
  Write-Warning "No Windows MSI installer found"
}

$exeCandidates = @(
  "src-tauri/target/release/codex-switch.exe",
  "src-tauri/target/x86_64-pc-windows-msvc/release/codex-switch.exe"
)

$exePath = $exeCandidates |
  ForEach-Object { Join-Path $ProjectRoot $_ } |
  Where-Object { Test-Path $_ } |
  Select-Object -First 1

if ($null -ne $exePath) {
  $portableDir = Join-Path $ReleaseAssetsDir "Codex-Switch-Portable"
  New-Item -ItemType Directory -Force -Path $portableDir | Out-Null
  Copy-Item $exePath $portableDir

  $portableIniPath = Join-Path $portableDir "portable.ini"
  $portableContent = @(
    "# Codex Switch portable build marker",
    "portable=true"
  )
  $portableContent | Set-Content -Path $portableIniPath -Encoding UTF8

  $portableZip = Join-Path $ReleaseAssetsDir ("Codex-Switch-$VersionTag-Windows-Portable.zip")
  Compress-Archive -Path (Join-Path $portableDir "*") -DestinationPath $portableZip -Force
  Remove-Item -Recurse -Force $portableDir
  Write-Host "Windows portable zip created: Codex-Switch-$VersionTag-Windows-Portable.zip"
}
else {
  Write-Warning "Portable exe not found"
}

Write-Host ""
Write-Host "Release assets:"
Get-ChildItem -Path $ReleaseAssetsDir -File | Sort-Object Name | ForEach-Object {
  Write-Host (" - " + $_.FullName)
}
