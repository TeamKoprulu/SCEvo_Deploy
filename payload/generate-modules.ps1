param(
    [string]$Root = (Get-Location).Path,
    [string]$OutFile = "generated-modules.txt"
)

$ErrorActionPreference = "Stop"

$Extensions = @(".SC2Mod", ".SC2Map", ".SC2Campaign", ".SC2Interface", ".SC2Locale")

function Get-RelativePath([string]$BasePath, [string]$FullPath) {
    $base = [System.IO.Path]::GetFullPath($BasePath)
    $full = [System.IO.Path]::GetFullPath($FullPath)

    if (-not $base.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
        $base += [System.IO.Path]::DirectorySeparatorChar
    }

    $baseUri = New-Object System.Uri($base)
    $fullUri = New-Object System.Uri($full)
    $relUri = $baseUri.MakeRelativeUri($fullUri)
    return [System.Uri]::UnescapeDataString($relUri.ToString())
}

function Get-ModuleId([string]$FileNameWithoutExtension) {
    $id = $FileNameWithoutExtension -replace "_", "-"
    $id = $id -replace "\s+", "-"
    $id = $id -replace "[^a-zA-Z0-9\-]", "-"
    $id = $id.ToLower()
    $id = $id -replace "-+", "-"
    $id = $id.Trim("-")
    return $id
}

function Get-ModuleName([string]$FileNameWithoutExtension) {
    $name = $FileNameWithoutExtension -replace "_", " "
    $name = $name -replace "-", " "
    $name = $name.Trim()
    return $name
}

Write-Host ""
Write-Host "Scanning: $Root" -ForegroundColor Cyan
Write-Host ""

$files = Get-ChildItem -Path $Root -Recurse -File | Where-Object {
    $Extensions -contains $_.Extension
} | Sort-Object FullName

if (-not $files -or $files.Count -eq 0) {
    Write-Host "No SC2 package files found." -ForegroundColor Yellow
    exit 1
}

$moduleObjects = @()

foreach ($file in $files) {
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
    $moduleId = Get-ModuleId $baseName
    $moduleName = Get-ModuleName $baseName
    $moduleDescription = $moduleName
    $relativePath = Get-RelativePath $Root $file.FullName
    $relativePath = $relativePath -replace "\\", "/"

    Write-Host "Hashing: $relativePath" -ForegroundColor Gray
    $hash = (Get-FileHash -Path $file.FullName -Algorithm SHA256).Hash.ToLower()

    $moduleObjects += [PSCustomObject]@{
        id = $moduleId
        name = $moduleName
        description = $moduleDescription
        files = @(
            [PSCustomObject]@{
                name = $file.Name
                path = $relativePath
                size = [int64]$file.Length
                hash = $hash
            }
        )
    }
}

$json = $moduleObjects | ConvertTo-Json -Depth 10

Set-Content -Path $OutFile -Value $json -Encoding UTF8

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "Output: $OutFile" -ForegroundColor White
Write-Host ""