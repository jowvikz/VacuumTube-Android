plugins {
    id("com.android.application")
}

// The injected page-world bundle is generated from vendor/vacuumtube-preload by the same script the
// manual build uses, so the Gradle and script builds cannot drift apart.
val bundlePreload = tasks.register<Exec>("bundlePreload") {
    description = "Regenerates app/src/main/assets/vt/preload.bundle.js from the ported preload tree"
    workingDir = rootProject.projectDir
    commandLine("node", "tools/bundle-preload.mjs")
}

android {
    namespace = "rocks.shy.vacuumtube.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "rocks.shy.vacuumtube.android"
        minSdk = 24
        targetSdk = 35
        versionCode = 2000000
        versionName = "2.0.0-android"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // No AndroidX / no third-party dependencies: the port uses the platform WebView, org.json and
    // java.net only, which is what makes the manual aapt2/d8 pipeline possible.
}

tasks.named("preBuild") {
    dependsOn(bundlePreload)
}
