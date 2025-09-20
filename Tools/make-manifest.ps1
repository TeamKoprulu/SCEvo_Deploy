param(
  [string]$ContentRoot = "payload",
  [string]$OutFile = "manifest.json",
  [string]$BaseUrl = "https://raw.githubusercontent.com/REPLACE_USER/REPLACE_REPO/main/payload/"
)

function Get-Sha256([string]$path) {
  $h = Get-FileHash -Algorithm SHA256 -Path $path
  $h.Hash.ToLower()
}

if (!(Test-Path $ContentRoot)) {
  Write-Error "Content root '$ContentRoot' not found."
  exit 1
}

$files = Get-ChildItem -File -Recurse $ContentRoot

$items = @()
foreach ($f in $files) {
  $rel = $f.FullName.Substring((Resolve-Path $ContentRoot).Path.Length).TrimStart('\','/')
  $rel = $rel -replace '\\','/'   # use forward slashes in URLs
  $items += [pscustomobject]@{
    path   = $rel
    size   = [int64]$f.Length
    sha256 = Get-Sha256 $f.FullName
  }
}

$manifest = [pscustomobject]@{
  version = (Get-Date).ToUniversalTime().ToString("o")
  baseUrl = $BaseUrl.TrimEnd('/') + '/'
  files   = $items | Sort-Object path
}

$opts = @{ Depth = 10; Compress = $false }
$manifest | ConvertTo-Json @opts | Set-Content -Path $OutFile -Encoding UTF8

Write-Host "Wrote $OutFile with $($items.Count) files."
