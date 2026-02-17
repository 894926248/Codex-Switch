$ErrorActionPreference = "Stop"

$storePath = Join-Path $env:USERPROFILE ".codex_account_switcher\profiles.json"
if (-not (Test-Path $storePath)) {
  throw "profiles.json not found: $storePath"
}

$backupPath = "$storePath.bak.$((Get-Date).ToString('yyyyMMdd_HHmmss'))"
Copy-Item $storePath $backupPath -Force

$jsonText = Get-Content $storePath -Raw -Encoding UTF8
$data = $jsonText | ConvertFrom-Json
if ($null -eq $data.profiles) {
  throw "profiles missing"
}

$profiles = @{}
foreach ($p in $data.profiles.PSObject.Properties) {
  $profiles[$p.Name] = $p.Value
}

function Normalize-Identity([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $null
  }
  return $value.Trim().ToLowerInvariant()
}

function Get-SortStamp($record) {
  if ($record.updated_at) {
    return [string]$record.updated_at
  }
  if ($record.last_checked_at) {
    return [string]$record.last_checked_at
  }
  return ""
}

function Has-Alias($record) {
  return -not [string]::IsNullOrWhiteSpace([string]$record.workspace_alias)
}

$groups = @{}
foreach ($name in $profiles.Keys) {
  $record = $profiles[$name]
  $workspaceId = Normalize-Identity([string]$record.workspace_id)
  $email = Normalize-Identity([string]$record.email)
  if ($workspaceId -and $email) {
    $key = "$workspaceId|$email"
    if (-not $groups.ContainsKey($key)) {
      $groups[$key] = New-Object System.Collections.Generic.List[string]
    }
    $groups[$key].Add($name) | Out-Null
  }
}

$active = [string]$data.active_profile
$toRemove = New-Object System.Collections.Generic.List[string]
$activeRebind = @{}

foreach ($key in $groups.Keys) {
  $names = $groups[$key]
  if ($names.Count -le 1) {
    continue
  }

  $keep = $null
  if ($active -and ($names -contains $active)) {
    $keep = $active
  }

  if (-not $keep) {
    $aliasNames = @($names | Where-Object { Has-Alias($profiles[$_]) })
    if ($aliasNames.Count -gt 0) {
      $keep = $aliasNames |
        Sort-Object -Property @{ Expression = { Get-SortStamp($profiles[$_]) }; Descending = $true } |
        Select-Object -First 1
    }
  }

  if (-not $keep) {
    $keep = $names |
      Sort-Object -Property @{ Expression = { Get-SortStamp($profiles[$_]) }; Descending = $true } |
      Select-Object -First 1
  }

  foreach ($name in $names) {
    if ($name -ne $keep) {
      $toRemove.Add($name) | Out-Null
      if ($active -eq $name) {
        $activeRebind[$name] = $keep
      }
    }
  }
}

$removedCount = 0
foreach ($name in $toRemove) {
  if ($profiles.ContainsKey($name)) {
    $record = $profiles[$name]
    $profiles.Remove($name)
    $removedCount++

    $snapshotDir = [string]$record.snapshot_dir
    if ([string]::IsNullOrWhiteSpace($snapshotDir)) {
      $snapshotDir = Join-Path (Join-Path $env:USERPROFILE ".codex_account_switcher\profiles") $name
    }
    if (Test-Path $snapshotDir) {
      Remove-Item $snapshotDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

if ($removedCount -gt 0) {
  $ordered = New-Object System.Collections.Generic.List[string]
  foreach ($n in $data.profile_order) {
    $name = [string]$n
    if ($profiles.ContainsKey($name) -and -not $ordered.Contains($name)) {
      $ordered.Add($name) | Out-Null
    }
  }
  $missing = @($profiles.Keys | Where-Object { -not $ordered.Contains($_) } | Sort-Object)
  foreach ($name in $missing) {
    $ordered.Add($name) | Out-Null
  }
  $data.profile_order = @($ordered)
}

if ($activeRebind.ContainsKey($active)) {
  $data.active_profile = $activeRebind[$active]
}

if ($data.active_profile -and -not $profiles.ContainsKey([string]$data.active_profile)) {
  if ($data.profile_order.Count -gt 0) {
    $data.active_profile = [string]$data.profile_order[0]
  } else {
    $data.active_profile = $null
  }
}

$newProfilesObj = [ordered]@{}
foreach ($name in ($profiles.Keys | Sort-Object)) {
  $newProfilesObj[$name] = $profiles[$name]
}
$data.profiles = $newProfilesObj

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($storePath, (($data | ConvertTo-Json -Depth 100) + "`n"), $utf8NoBom)

Write-Output "backup=$backupPath"
Write-Output "removed=$removedCount"
Write-Output "active=$($data.active_profile)"
Write-Output "count=$($profiles.Count)"
