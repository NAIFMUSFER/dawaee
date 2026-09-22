#!/usr/bin/env bash
# Disposable CI emulator only. Never connects to a real phone or production API.
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
test "${DAWAEE_DEVICE_CI:-}" = 1
test "${EXPO_PUBLIC_API_URL:-}" = http://127.0.0.1:8080
mkdir -p android-interaction-evidence
git rev-parse HEAD > android-interaction-evidence/app-commit.txt
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
APK=apps/mobile/android/app/build/outputs/apk/release/app-release.apk
test "$("$ANDROID_HOME/cmdline-tools/latest/bin/apkanalyzer" manifest application-id "$APK")" = app.dawaee.audit
sha256sum "$APK" > android-interaction-evidence/apk-sha256.txt
cp "$APK" android-interaction-evidence/emulator-only.apk
printf '%s\n' 'x86_64 emulator evidence only; not a phone or store release.' > android-interaction-evidence/README.txt
adb start-server
emulator -avd tadawee_audit -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect -camera-back none -camera-front none > android-interaction-evidence/emulator.log 2>&1 &
emulator_pid=$!
trap 'tail -40 android-interaction-evidence/emulator.log; kill "$emulator_pid" 2>/dev/null || true' EXIT
deadline=$((SECONDS + 180))
booted=0
while [ "$SECONDS" -lt "$deadline" ]; do
  kill -0 "$emulator_pid" || { echo 'FAIL emulator exited before boot'; exit 1; }
  if [ "$(timeout 5 adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)" = 1 ]; then booted=1; break; fi
  sleep 2
done
test "$booted" = 1 || { echo 'FAIL emulator did not boot within 180 seconds'; exit 1; }
echo 'PASS emulator booted; beginning native interaction'
adb shell input keyevent 82
adb shell settings put secure show_ime_with_hard_keyboard 1
timeout 90 adb install "$APK"
adb reverse tcp:8080 tcp:8080
python3 scripts/android-interaction/check.py
python3 scripts/android-interaction/dose_check.py
