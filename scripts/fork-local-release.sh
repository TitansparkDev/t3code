#!/usr/bin/env bash
# Builds the fork's release assets locally (GitHub Actions does not run on this fork).
# Usage: scripts/fork-local-release.sh <version> [cli|desktop|windows|android|all]
# Wrap each stage in `agentq run --resource heavy_build --timeout 3000 --`.
set -euo pipefail

version="${1:?version, e.g. 0.1.10}"
stage="${2:-all}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# Native executables must be built with exactly the Node version in package.json engines.
VP_NODE_VERSION="$(node -p 'require("./package.json").engines.node')"
export VP_NODE_VERSION
export T3CODE_DESKTOP_UPDATE_REPOSITORY="${T3CODE_DESKTOP_UPDATE_REPOSITORY:-TitansparkDev/t3code}"
cli_archive="$root/release-cli/t3-$version-linux-x64.tar.gz"

cli() {
  rm -rf release-cli
  vp run --filter=@t3tools/web build
  node apps/server/scripts/cli.ts build --verbose
  node apps/server/scripts/cli.ts build-exe --verbose
  cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml --target x86_64-unknown-linux-gnu
  monitor_dir="$(mktemp -d)"
  # The directory is copied flat into the archive's resource-monitor/.
  cp native/resource-monitor/target/x86_64-unknown-linux-gnu/release/t3-resource-monitor "$monitor_dir/"
  node scripts/build-cli-archive.ts --platform linux --arch x64 --version "$version" \
    --resource-monitor-dir "$monitor_dir" --output-dir release-cli
  node scripts/smoke-cli-archive.ts --archive "$cli_archive" --expect-version "$version"
  rm -rf "$monitor_dir"
}

desktop() {
  vp run dist:desktop:artifact --platform linux --target AppImage --arch x64 --build-version "$version"
}

windows() {
  [[ -f "$cli_archive" ]] || { echo "build the cli stage first" >&2; exit 1; }
  # There is no MSVC linker here: cross-build the monitor with mingw and let the packager reuse it.
  cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml --target x86_64-pc-windows-gnu
  mkdir -p native/resource-monitor/target/x86_64-pc-windows-msvc/release
  cp native/resource-monitor/target/x86_64-pc-windows-gnu/release/t3-resource-monitor.exe \
    native/resource-monitor/target/x86_64-pc-windows-msvc/release/
  T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true vp run dist:desktop:artifact \
    --platform win --target nsis --arch x64 --build-version "$version" --wsl-runtime "$cli_archive"
}

android() {
  export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
  export ANDROID_SDK_ROOT="$ANDROID_HOME"
  export APP_VARIANT=production
  export EXPO_NO_GIT_STATUS=1
  (cd apps/mobile && vp exec expo prebuild --platform android)
  cd apps/mobile/android
  # Agents run in an 8 GiB cgroup. Without CI=1 Expo's Metro peaks near 6 GB (1.5 GB with it) and
  # was OOM-killed three times; keep the bundle apart from the Gradle JVM (about 3 GB compiling).
  export CI=1
  NODE_OPTIONS=--max-old-space-size=5120 ./gradlew :app:createBundleReleaseJsAndAssets \
    --no-daemon --console=plain -Dorg.gradle.jvmargs="-Xmx512m -XX:MaxMetaspaceSize=256m"
  CMAKE_BUILD_PARALLEL_LEVEL=3 ./gradlew :app:assembleRelease --no-daemon --console=plain \
    -Dorg.gradle.workers.max=3 -Dorg.gradle.parallel=false \
    -Dorg.gradle.jvmargs="-Xmx3g -XX:MaxMetaspaceSize=512m" \
    -Pkotlin.compiler.execution.strategy=in-process
  cp app/build/outputs/apk/release/app-release.apk "$root/release/t3code-android-$version-production.apk"
}

case "$stage" in
  cli) cli ;;
  desktop) desktop ;;
  windows) windows ;;
  android) android ;;
  all) cli; desktop; windows; android ;;
  *) echo "unknown stage: $stage" >&2; exit 1 ;;
esac
