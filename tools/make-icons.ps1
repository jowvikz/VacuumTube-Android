# Generates launcher icons and the Android TV banner from the app's own icon.png
# (vendor/vacuumtube-preload/assets/icon.png, the file the desktop app shipped).
param(
    [string]$Source = ""
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$proj = Split-Path -Parent $PSScriptRoot
if (-not $Source) { $Source = Join-Path $proj 'vendor\vacuumtube-preload\assets\icon.png' }
$res = Join-Path $proj 'app\src\main\res'

if (-not (Test-Path $Source)) { throw "icon not found: $Source" }

$sourceImage = [System.Drawing.Image]::FromFile($Source)

function Save-Resized {
    param([System.Drawing.Image]$Image, [int]$Size, [string]$Path)
    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.DrawImage($Image, 0, 0, $Size, $Size)
    } finally {
        $graphics.Dispose()
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
    Write-Host ("icon  {0,4}x{0,-4} -> {1}" -f $Size, $Path.Replace("$proj\", ''))
}

# Launcher icons: 48dp at each density.
$densities = @{ 'mipmap-mdpi' = 48; 'mipmap-hdpi' = 72; 'mipmap-xhdpi' = 96; 'mipmap-xxhdpi' = 144; 'mipmap-xxxhdpi' = 192 }
foreach ($entry in $densities.GetEnumerator()) {
    Save-Resized -Image $sourceImage -Size $entry.Value -Path (Join-Path $res "$($entry.Key)\ic_launcher.png")
}

# Android TV banner: 320x180 dp => 640x360 px at xhdpi.
$bannerWidth = 640
$bannerHeight = 360
$banner = New-Object System.Drawing.Bitmap($bannerWidth, $bannerHeight, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($banner)
try {
    $graphics.Clear([System.Drawing.Color]::FromArgb(255, 40, 40, 40))
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $iconSize = [Math]::Min($bannerHeight - 60, $bannerWidth - 60)
    $x = [int](($bannerWidth - $iconSize) / 2)
    $y = [int](($bannerHeight - $iconSize) / 2)
    $graphics.DrawImage($sourceImage, $x, $y, $iconSize, $iconSize)
} finally {
    $graphics.Dispose()
}
$bannerPath = Join-Path $res 'drawable-xhdpi\banner.png'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $bannerPath) | Out-Null
$banner.Save($bannerPath, [System.Drawing.Imaging.ImageFormat]::Png)
$banner.Dispose()
Write-Host ("banner {0}x{1} -> {2}" -f $bannerWidth, $bannerHeight, $bannerPath.Replace("$proj\", ''))

$sourceImage.Dispose()
Write-Host 'icons generated'
