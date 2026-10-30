plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.fengli.beayy"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.fengli.beayy"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.2.39-android-mvp"
        ndk {
            abiFilters += listOf("arm64-v8a")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
        debug {
            isDebuggable = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    // ui/ 由 scripts/sync-ui.sh 拷到 assets/ui；不要手改 assets
    sourceSets {
        getByName("main") {
            assets.srcDirs("src/main/assets")
        }
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.webkit:webkit:1.12.1")
}

// 可选：有 NDK + cargo-ndk 时，assemble 前编 libbeayy_mobile.so
tasks.register<Exec>("cargoNdkArm64") {
    workingDir = rootProject.projectDir.parentFile // 仓库根（android/ 的上一级）
    commandLine(
        "cargo", "ndk",
        "-t", "arm64-v8a",
        "-o", "android/app/src/main/jniLibs",
        "build", "-p", "beayy-mobile", "--release",
    )
    onlyIf {
        file("${rootProject.projectDir.parentFile}/mobile/Cargo.toml").exists()
            && (System.getenv("ANDROID_NDK_HOME") != null
            || System.getenv("NDK_HOME") != null
            || file("${System.getenv("ANDROID_HOME") ?: ""}/ndk").exists())
    }
}
