plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 版本跟电脑版（app/Cargo.toml 的 workspace 版本）走
val beayyVersion: String = Regex("""(?m)^version = "([^"]+)"""").find(rootDir.resolve("../Cargo.toml").readText())!!.groupValues[1]

android {
    namespace = "com.fengli.beayy"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.fengli.beayy"
        minSdk = 26
        targetSdk = 35
        versionName = beayyVersion
        versionCode = beayyVersion.split(".").fold(0) { a, x -> a * 1000 + x.toInt() }
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            // 没配正式签名时用调试签名，装得上；要上架再换
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    // ui/ 和 Rust 的 .so 由 build.sh 放进 android/out/ 下，不进 git
    sourceSets["main"].assets.srcDirs(rootProject.file("out/web"))
    sourceSets["main"].jniLibs.srcDirs(rootProject.file("out/jni"))
}
