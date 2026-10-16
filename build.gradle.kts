// Android Studio entry point. The verified, dependency-free build is tools/build-apk.ps1
// (aapt2 + javac + d8 + zipalign + apksigner, no Gradle); this file exists so the project can also
// be opened and run from Android Studio.
//
// ONE DIFFERENCE to be aware of: aapt2 requires the `package` attribute in AndroidManifest.xml,
// while AGP 8 forbids it (the namespace below replaces it). Delete the `package="..."`
// line from app/src/main/AndroidManifest.xml before using this Gradle build, or build with
// tools/build-apk.ps1 which needs it.
plugins {
    id("com.android.application") version "8.7.3" apply false
}
