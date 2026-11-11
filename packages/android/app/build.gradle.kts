import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The app's version follows LootDen's (the root package.json), so the server's Get the app page
// and the app's own update check agree on what's newest.
val lootdenVersion: String = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
    .find(rootDir.resolve("../../package.json").readText())!!.groupValues[1]
val versionParts = lootdenVersion.split(".").map { it.takeWhile(Char::isDigit).toIntOrNull() ?: 0 }

// Release signing from the environment (CI) or keystore.properties (a local build). Without a key
// the release build falls back to the debug key, which can't update a copy signed with the real one.
val keystoreProps = Properties().apply {
    val f = rootDir.resolve("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun signingValue(env: String, prop: String): String? = System.getenv(env)?.takeIf { it.isNotBlank() } ?: keystoreProps.getProperty(prop)
val storePath = signingValue("LOOTDEN_ANDROID_KEYSTORE", "storeFile")

android {
    namespace = "app.lootden.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.lootden.android"
        minSdk = 26
        targetSdk = 35
        versionName = lootdenVersion
        versionCode = versionParts.getOrElse(0) { 0 } * 1_000_000 + versionParts.getOrElse(1) { 0 } * 1_000 + versionParts.getOrElse(2) { 0 }
    }

    signingConfigs {
        if (storePath != null) {
            create("release") {
                storeFile = file(storePath)
                storePassword = signingValue("LOOTDEN_ANDROID_KEYSTORE_PASSWORD", "storePassword")
                keyAlias = signingValue("LOOTDEN_ANDROID_KEY_ALIAS", "keyAlias")
                keyPassword = signingValue("LOOTDEN_ANDROID_KEY_PASSWORD", "keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (storePath != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.webkit:webkit:1.12.1")
}
