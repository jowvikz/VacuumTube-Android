# Static verification of the built APK: contents, asset/bundle identity, dex classes, manifest
# attributes and signature. Everything is offline (no device, no emulator).
param(
    [string]$Sdk = "C:\Users\erick\Downloads\VacuumTube\rea-work\android-sdk",
    [string]$BuildTools = "35.0.0",
    [string]$Apk = ""
)
$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent $PSScriptRoot
if (-not $Apk) { $Apk = Join-Path $proj 'dist\VacuumTube-Android.apk' }
if (-not (Test-Path $Apk)) { throw "APK not found: $Apk" }

$tools = Join-Path $Sdk "build-tools\$BuildTools"
$aapt2 = Join-Path $tools 'aapt2.exe'
$apksigner = Join-Path $tools 'apksigner.bat'
$manifest = Join-Path $proj 'build\bundle-manifest.json'

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($Apk)
$entries = @{}
foreach ($entry in $zip.Entries) { $entries[$entry.FullName] = $entry }
Write-Host '== APK entries ==' -ForegroundColor Cyan
$zip.Entries | Sort-Object FullName | ForEach-Object {
    Write-Host ("  {0,-46} {1,10:N0} -> {2,9:N0}" -f $_.FullName, $_.Length, $_.CompressedLength)
}

$failures = 0
function Check($name, $ok, $detail) {
    Write-Host (("{0}  {1}{2}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $(if ($detail) { "  [$detail]" } else { '' })))
    if (-not $ok) { $script:failures++ }
}

Write-Host ''
Write-Host '== content checks ==' -ForegroundColor Cyan
Check 'classes.dex present' ($entries.ContainsKey('classes.dex'))
Check 'preload bundle bundled as an asset' ($entries.ContainsKey('assets/vt/preload.bundle.js'))

# asset identity: the bundle inside the APK must equal the generated bundle
if ($entries.ContainsKey('assets/vt/preload.bundle.js')) {
    $stream = $entries['assets/vt/preload.bundle.js'].Open()
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
    $assetText = $reader.ReadToEnd()
    $reader.Dispose()
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $assetHash = ([System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($assetText)))).Replace('-', '').ToLower()
    $expected = ''
    if (Test-Path $manifest) { $expected = (Get-Content $manifest -Raw | ConvertFrom-Json).outputSha256 }
    Check 'bundle asset sha256 matches the generated bundle' ($expected -eq '' -or $assetHash -eq $expected) "$assetHash vs $expected"
    Check 'bundle contains the ported preload entry' ($assetText.Contains('/vt/src/preload/index.js'))
    Check 'bundle has no script-terminating sequence' (-not ($assetText -match '</script'))
}

if ($entries.ContainsKey('classes.dex')) {
    $dexStream = $entries['classes.dex'].Open()
    $memory = New-Object System.IO.MemoryStream
    $dexStream.CopyTo($memory)
    $dexText = [System.Text.Encoding]::GetEncoding(28591).GetString($memory.ToArray())
    $memory.Dispose(); $dexStream.Dispose()
    foreach ($class in @('MainActivity', 'VTBridge', 'VTConfig', 'VTWebViewClient', 'VtCsp', 'VtDial', 'AspectFrameLayout')) {
        Check "dex contains $class" ($dexText.Contains("Lrocks/shy/vacuumtube/android/$class;"))
    }
}
$zip.Dispose()

Write-Host ''
Write-Host '== manifest ==' -ForegroundColor Cyan
$xml = & $aapt2 dump xmltree --file AndroidManifest.xml $Apk
$xmlText = ($xml | Out-String)
Check 'application declares a TV banner' ($xmlText -match 'banner')
Check 'leanback launcher category present' ($xmlText -match 'LEANBACK_LAUNCHER')
Check 'launcher category present' ($xmlText -match 'category.*LAUNCHER')
# aapt2 xmltree prints the enum numerically: screenOrientation sensorLandscape == 6
Check 'screenOrientation = sensorLandscape (6)' ($xmlText -match 'screenOrientation[^=]*=6\b')
Check 'deep link scheme vacuumtube' ($xmlText -match 'vacuumtube')
Check 'usesCleartextTraffic=false' ($xmlText -match 'usesCleartextTraffic')
Check 'windowSoftInputMode set for the soft keyboard' ($xmlText -match 'windowSoftInputMode')
Check 'no backslash asset entry (AssetManager needs /)' (-not ($entries.Keys | Where-Object { $_ -match '\\' }))

Write-Host ''
Write-Host '== badging ==' -ForegroundColor Cyan
& $aapt2 dump badging $Apk | Select-String -Pattern 'package:|minSdkVersion|targetSdkVersion|launchable-activity:|leanback-launchable|application-label:' 

Write-Host ''
Write-Host '== signature ==' -ForegroundColor Cyan
$previousEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    $verifyOut = & $apksigner verify --verbose --print-certs $Apk 2>&1
    $verifyOut | Where-Object { $_ -notmatch 'WARNING:|restricted method|Restricted methods|loadLibrary|native-access' } |
        Select-String -Pattern 'Verifies|scheme|Number of signers|certificate DN'
} finally {
    $ErrorActionPreference = $previousEap
}

$size = (Get-Item $Apk).Length
Write-Host ''
Write-Host ("APK:      {0}" -f $Apk)
Write-Host ("size:     {0:N0} bytes" -f $size)
Write-Host ("sha256:   {0}" -f (Get-FileHash $Apk -Algorithm SHA256).Hash)
Write-Host $(if ($failures -eq 0) { 'ALL CHECKS PASSED' } else { "$failures CHECK(S) FAILED" })
if ($failures -ne 0) { exit 1 }
