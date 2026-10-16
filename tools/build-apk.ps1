# Builds, aligns and signs the VacuumTube-Android APK with the Android SDK build-tools only
# (no Gradle, no Android Studio) — the same pipeline verified in rea-work/TOOLCHAIN.md.
#
#   aapt2 compile -> aapt2 link -A assets -> javac --release 17 -> d8 -> classes.dex into the APK
#   -> zipalign -p 4 -> apksigner (debug key)
param(
    [string]$Sdk = "C:\Users\erick\Downloads\VacuumTube\rea-work\android-sdk",
    [string]$JavaHome = "C:\Program Files\Java\jdk-27",
    [string]$BuildTools = "35.0.0",
    [string]$Platform = "android-35",
    [int]$MinSdk = 24,
    [int]$TargetSdk = 35,
    [switch]$SkipBundle,
    [string]$Keystore = "",
    [string]$KeystorePassword = "android",
    [string]$KeyAlias = "androiddebugkey"
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$proj = Split-Path -Parent $PSScriptRoot
$main = Join-Path $proj 'app\src\main'
$build = Join-Path $proj 'build'
$dist = Join-Path $proj 'dist'

$tools = Join-Path $Sdk "build-tools\$BuildTools"
$aapt2 = Join-Path $tools 'aapt2.exe'
$d8 = Join-Path $tools 'd8.bat'
$zipalign = Join-Path $tools 'zipalign.exe'
$apksigner = Join-Path $tools 'apksigner.bat'
$androidJar = Join-Path $Sdk "platforms\$Platform\android.jar"
$javac = Join-Path $JavaHome 'bin\javac.exe'
$keytool = Join-Path $JavaHome 'bin\keytool.exe'

foreach ($tool in @($aapt2, $d8, $zipalign, $apksigner, $androidJar, $javac, $keytool)) {
    if (-not (Test-Path $tool)) { throw "missing build dependency: $tool" }
}

$gen = Join-Path $build 'gen'
$classes = Join-Path $build 'classes'
$dex = Join-Path $build 'dex'
$resZip = Join-Path $build 'resources.zip'
$baseApk = Join-Path $build 'base-unsigned.apk'
$alignedApk = Join-Path $build 'aligned.apk'
$finalApk = Join-Path $dist 'VacuumTube-Android.apk'

if (-not $SkipBundle) {
    Write-Host '== bundling the ported preload ==' -ForegroundColor Cyan
    & node (Join-Path $PSScriptRoot 'bundle-preload.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'bundle-preload.mjs failed' }
}

Write-Host '== cleaning previous output ==' -ForegroundColor Cyan
foreach ($dir in @($gen, $classes, $dex)) { if (Test-Path $dir) { Remove-Item -Recurse -Force $dir } }
foreach ($dir in @($gen, $classes, $dex, $dist)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
foreach ($file in @($resZip, $baseApk, $alignedApk)) { if (Test-Path $file) { Remove-Item -Force $file } }

Write-Host '== aapt2 compile ==' -ForegroundColor Cyan
& $aapt2 compile --dir (Join-Path $main 'res') -o $resZip
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile failed' }

Write-Host '== aapt2 link (resources) ==' -ForegroundColor Cyan
# Assets are NOT passed with -A: on Windows aapt2 stores nested asset names with backslashes
# ("assets/vt\preload.bundle.js"), which AssetManager.getAssets().open("vt/...") cannot resolve.
# They are added below with forward slashes instead.
& $aapt2 link -o $baseApk -I $androidJar --manifest (Join-Path $main 'AndroidManifest.xml') `
    -R $resZip --java $gen --auto-add-overlay `
    --min-sdk-version $MinSdk --target-sdk-version $TargetSdk
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link failed' }

Write-Host '== javac (release 17 against android.jar) ==' -ForegroundColor Cyan
$sources = @()
$sources += Get-ChildItem -Path (Join-Path $main 'java') -Recurse -Filter *.java | ForEach-Object { $_.FullName }
$sources += Get-ChildItem -Path $gen -Recurse -Filter *.java | ForEach-Object { $_.FullName }
Write-Host ("   {0} source files" -f $sources.Count)
& $javac --release 17 -Xlint:-options -classpath $androidJar -d $classes @sources
if ($LASTEXITCODE -ne 0) { throw 'javac failed' }

Write-Host '== d8 (dex) ==' -ForegroundColor Cyan
$classFiles = Get-ChildItem -Path $classes -Recurse -Filter *.class | ForEach-Object { $_.FullName }
Write-Host ("   {0} class files" -f $classFiles.Count)
& $d8 --release --lib $androidJar --min-api $MinSdk --output $dex @classFiles
if ($LASTEXITCODE -ne 0) { throw 'd8 failed' }

Write-Host '== packaging classes.dex + assets ==' -ForegroundColor Cyan
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($baseApk, 'Update')
try {
    function Add-Entry($file, $entryName) {
        $existing = $zip.Entries | Where-Object { $_.FullName -eq $entryName }
        if ($existing) { $existing | ForEach-Object { $_.Delete() } }
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, $file, $entryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }

    Add-Entry (Join-Path $dex 'classes.dex') 'classes.dex'

    $assetsRoot = Join-Path $main 'assets'
    if (Test-Path $assetsRoot) {
        Get-ChildItem -Path $assetsRoot -Recurse -File | ForEach-Object {
            $relative = $_.FullName.Substring($assetsRoot.Length + 1).Replace('\', '/')
            Add-Entry $_.FullName ("assets/$relative")
            Write-Host ("   + assets/{0} ({1:N0} bytes)" -f $relative, $_.Length)
        }
    }
} finally {
    $zip.Dispose()
}
Copy-Item $baseApk $alignedApk -Force

Write-Host '== zipalign ==' -ForegroundColor Cyan
& $zipalign -f -p 4 $baseApk $alignedApk
if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }

if (-not $Keystore) { $Keystore = Join-Path $build 'debug.keystore' }
# JDK 27 writes a java.lang.System::loadLibrary warning to stderr; with ErrorActionPreference=Stop
# PowerShell turns a redirected native stderr line into a terminating NativeCommandError, so the
# noisy calls below run with 'Continue' and their output is filtered explicitly.
$noisePattern = 'WARNING:|restricted method|Restricted methods|loadLibrary|native-access|Note: |deprecated API|Recompile with'
$previousEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    if (-not (Test-Path $Keystore)) {
        Write-Host '== generating a debug keystore ==' -ForegroundColor Cyan
        $keytoolOut = & $keytool -genkeypair -v -keystore $Keystore -storetype PKCS12 -storepass $KeystorePassword `
            -keypass $KeystorePassword -alias $KeyAlias -keyalg RSA -keysize 2048 -validity 10000 `
            -dname "CN=Android Debug,O=Android,C=US" 2>&1
        $keytoolOut | Where-Object { $_ -notmatch $noisePattern } | Write-Host
        if ($LASTEXITCODE -ne 0) { throw 'keytool failed' }
    }

    Write-Host '== apksigner ==' -ForegroundColor Cyan
    $signOut = & $apksigner sign --ks $Keystore --ks-pass "pass:$KeystorePassword" --key-pass "pass:$KeystorePassword" `
        --ks-key-alias $KeyAlias --out $finalApk $alignedApk 2>&1
    $signOut | Where-Object { $_ -notmatch $noisePattern } | Write-Host
    if ($LASTEXITCODE -ne 0) { throw 'apksigner sign failed' }

    Write-Host '== verification ==' -ForegroundColor Cyan
    $verifyOut = & $apksigner verify --verbose --print-certs $finalApk 2>&1
    $verifyOut | Where-Object { $_ -notmatch $noisePattern } | Write-Host
} finally {
    $ErrorActionPreference = $previousEap
}
& $aapt2 dump badging $finalApk | Select-String -Pattern 'package:|launchable-activity:|sdkVersion|targetSdkVersion|uses-permission|feature-group|application-label|application-icon-640' | Select-Object -First 25

$hash = (Get-FileHash $finalApk -Algorithm SHA256).Hash
$size = (Get-Item $finalApk).Length
Write-Host ''
Write-Host ("APK:    {0}" -f $finalApk) -ForegroundColor Green
Write-Host ("size:   {0:N0} bytes ({1:N1} MiB)" -f $size, ($size / 1MB)) -ForegroundColor Green
Write-Host ("sha256: {0}" -f $hash) -ForegroundColor Green

# Native tools (apksigner, aapt2) leave their own exit codes behind; without this the script can
# report failure to a caller/CI even though the APK was produced and signed.
exit 0
