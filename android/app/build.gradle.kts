import org.gradle.api.tasks.Exec
import org.gradle.api.tasks.testing.Test
import org.gradle.jvm.toolchain.JavaLanguageVersion

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.android)
  alias(libs.plugins.kotlin.serialization)
  alias(libs.plugins.kotlin.kapt)
  alias(libs.plugins.hilt)
}

android {
  namespace = "com.igng.tokenmonitor.android"
  compileSdk = 36

  defaultConfig {
    applicationId = "com.igng.tokenmonitor.android"
    minSdk = 26
    targetSdk = 36
    val releaseVersion = providers.gradleProperty("tokenMonitorVersion").orElse(
      rootProject.file("../VERSION").takeIf { it.exists() }?.readText()?.trim() ?: "1.0.0"
    ).get()
    versionCode = releaseVersionCode(releaseVersion)
    versionName = releaseVersion
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }

  buildFeatures { compose = true; buildConfig = true }
  composeOptions { kotlinCompilerExtensionVersion = "1.5.14" }

  buildTypes {
    release {
      isMinifyEnabled = false
      val keystorePath = providers.gradleProperty("androidKeystorePath").orNull
      val keystorePassword = providers.gradleProperty("androidKeystorePassword").orNull
      val keyAlias = providers.gradleProperty("androidKeyAlias").orNull
      val keyPassword = providers.gradleProperty("androidKeyPassword").orNull
      if (keystorePath != null && keystorePassword != null && keyAlias != null && keyPassword != null) {
        signingConfig = signingConfigs.create("releaseSigning").apply {
          storeFile = file(keystorePath)
          storePassword = keystorePassword
          this.keyAlias = keyAlias
          this.keyPassword = keyPassword
        }
      }
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlin { jvmToolchain(17) }
}

private fun releaseVersionCode(version: String): Int {
  val match = Regex("^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-rev\\.([1-9]\\d*))?$").matchEntire(version)
    ?: error("Android release version must match <major>.<minor>.<patch>[-rev.<revision>]: $version")
  val major = match.groupValues[1].toLongOrNull()
    ?: error("Android release major version is too large: $version")
  val minor = match.groupValues[2].toLongOrNull()
    ?: error("Android release minor version is too large: $version")
  val patch = match.groupValues[3].toLongOrNull()
    ?: error("Android release patch version is too large: $version")
  val revision = if (match.groupValues[4].isNotEmpty()) {
    match.groupValues[4].toLongOrNull() ?: error("Android release revision is too large: $version")
  } else {
    0L
  }
  require(minor in 0..99 && patch in 0..99 && revision in 0..9999) {
    "Android version components exceed their encoding slots: $version"
  }
  val baseVersionCode = major * 10000L + minor * 100L + patch
  val versionCode = baseVersionCode * 10000L + revision
  require(versionCode in 1..Int.MAX_VALUE.toLong()) {
    "Android versionCode is outside the supported range: $version -> $versionCode"
  }
  return versionCode.toInt()
}

dependencies {
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.activity.compose)
  implementation(libs.androidx.lifecycle.runtime.ktx)
  implementation(libs.androidx.lifecycle.runtime.compose)
  implementation(libs.androidx.lifecycle.viewmodel.compose)
  implementation(libs.androidx.navigation.compose)
  implementation(platform(libs.compose.bom))
  implementation(libs.compose.ui)
  implementation(libs.compose.ui.tooling.preview)
  implementation(libs.compose.material3)
  implementation(libs.androidx.security.crypto)
  implementation(libs.androidx.work.runtime.ktx)
  implementation(libs.hilt.android)
  implementation(libs.androidx.hilt.navigation.compose)
  kapt(libs.hilt.compiler)
  implementation(libs.retrofit)
  implementation(libs.retrofit.kotlinx)
  implementation(libs.okhttp)
  implementation(libs.okhttp.sse)
  implementation(libs.kotlinx.serialization.json)
  implementation(libs.kotlinx.coroutines.android)
  implementation(libs.vico.compose)
  implementation(libs.vico.core)

  testImplementation(libs.junit)
  testImplementation(libs.mockwebserver)
  testImplementation(libs.kotlinx.coroutines.test)
  debugImplementation(libs.compose.ui.tooling)
}

kapt { correctErrorTypes = true }

val repositoryTestOutput = layout.buildDirectory.dir("intermediates/classes/debugUnitTest/transformDebugUnitTestClassesWithAsm/dirs")
val appRuntimeClasses = layout.buildDirectory.dir("intermediates/runtime_app_classes_jar/debug/bundleDebugClassesToRuntimeJar/classes.jar")
val testJavaResources = layout.buildDirectory.dir("intermediates/java_res/debugUnitTest/processDebugUnitTestJavaRes/out")

fun registerJunitCoreTask(name: String, descriptionText: String, vararg testClasses: String) =
  tasks.register(name, Exec::class) {
    group = "verification"
    description = descriptionText
    dependsOn("transformDebugUnitTestClassesWithAsm", "bundleDebugClassesToRuntimeJar", "processDebugUnitTestJavaRes")
    val launcher = javaToolchains.launcherFor { languageVersion.set(JavaLanguageVersion.of(17)) }
    val testRuntime = configurations.named("debugUnitTestRuntimeClasspath")
    doFirst {
      val discoveredTestClasses = if (testClasses.isNotEmpty()) {
        testClasses.toList()
      } else {
        val outputRoot = repositoryTestOutput.get().asFile
        outputRoot.walkTopDown()
          .filter { file ->
            file.isFile
              && !file.nameWithoutExtension.contains('$')
              && (file.name.endsWith("Test.class")
                || file.name.endsWith("Tests.class")
                || file.name.endsWith("TestCase.class"))
          }
          .map { file ->
            file.relativeTo(outputRoot).invariantSeparatorsPath
              .removeSuffix(".class")
              .replace('/', '.')
          }
          .sorted()
          .toList()
      }
      require(discoveredTestClasses.isNotEmpty()) {
        "No compiled Android unit test classes were discovered under ${repositoryTestOutput.get().asFile}"
      }
      val classpath = files(repositoryTestOutput, appRuntimeClasses, testJavaResources, testRuntime)
      commandLine(
        listOf(
          launcher.get().executablePath.asFile.absolutePath,
          "-cp",
          classpath.asPath,
          "org.junit.runner.JUnitCore"
        ) + discoveredTestClasses
      )
    }
  }

val runRepositoryTests = registerJunitCoreTask(
  "runRepositoryTests",
  "Runs Repository MockWebServer tests without Gradle's Windows argfile worker.",
  "com.igng.tokenmonitor.android.data.repository.HubRepositoryTest"
)

val runHistoryLimitsTests = registerJunitCoreTask(
  "runHistoryLimitsTests",
  "Runs historyPreview/limits DTO parsing tests without Gradle's Windows argfile worker.",
  "com.igng.tokenmonitor.android.data.model.HubDtosHistoryLimitsTest"
)

val runFormattersHelpersTests = registerJunitCoreTask(
  "runFormattersHelpersTests",
  "Runs Formatters helper unit tests without Gradle's Windows argfile worker.",
  "com.igng.tokenmonitor.android.ui.components.FormattersHelpersTest"
)

val runUnitTests = registerJunitCoreTask(
  "runUnitTests",
  "Runs all compiled local unit tests via JUnitCore (Windows argfile workaround)."
)

// The JUnitCore tasks above exist because a Windows classpath overflows the command
// line; they were also *disabling* Gradle's own `test` task, which made `./gradlew test`
// a silent no-op — a green run that ran nothing.  Both paths now work: `test` is the
// standard entry point (and what CI calls), the JUnitCore tasks remain for a Windows
// shell that cannot carry the classpath.
tasks.withType<Test>().configureEach {
  enabled = true
  testLogging {
    events("passed", "skipped", "failed")
  }
}
