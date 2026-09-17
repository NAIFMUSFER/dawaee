#!/usr/bin/env bash
# Disposable CI emulator only. Never connects to a real phone or production API.
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
test "${EXPO_PUBLIC_API_URL:-}" = https://dawaee-audit-preview.onrender.com
mkdir -p android-interaction-evidence
git rev-parse HEAD > android-interaction-evidence/app-commit.txt
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
emulator -avd tadawee_audit -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect -camera-back none -camera-front none > android-interaction-evidence/emulator.log 2>&1 &
emulator_pid=$!
trap 'kill "$emulator_pid" 2>/dev/null || true' EXIT
adb wait-for-device
for attempt in $(seq 1 90); do
  if [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = 1 ]; then break; fi
  sleep 2
done
test "$(adb shell getprop sys.boot_completed | tr -d '\r')" = 1
adb shell input keyevent 82
APK=apps/mobile/android/app/build/outputs/apk/release/app-release.apk
test "$("$ANDROID_HOME/cmdline-tools/latest/bin/apkanalyzer" manifest application-id "$APK")" = app.dawaee.audit
sha256sum "$APK" > android-interaction-evidence/apk-sha256.txt
adb install "$APK"
python3 scripts/android-interaction/check.py
