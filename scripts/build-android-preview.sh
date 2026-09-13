#!/usr/bin/env bash
# Native QA package. Production app identity and runtime files are unchanged.
set -euo pipefail

TASK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASK_MOBILE="$TASK_ROOT/apps/mobile"
TASK_OUTPUT="$TASK_ROOT/artifacts/android-preview"
TASK_API='https://dawaee-audit-preview.onrender.com'
: "${ANDROID_HOME:?An installed Android SDK is required}"
: "${JAVA_HOME:?An installed JDK 17 is required}"
test -x "$JAVA_HOME/bin/javac"
if [ -e "$TASK_MOBILE/android" ]; then
  echo 'Use a clean checkout: this script does not replace an existing native project.' >&2
  exit 1
fi
if [ "${EXPO_PUBLIC_API_URL:-$TASK_API}" != "$TASK_API" ]; then
  echo 'This QA build is restricted to the isolated audit API.' >&2
  exit 1
fi

export CI=1 EXPO_NO_TELEMETRY=1 EXPO_PUBLIC_DEMO=0
export EXPO_PUBLIC_API_URL="$TASK_API"
mkdir -p "$TASK_OUTPUT"
TASK_CONFIG_BACKUP="$(mktemp)"
cp "$TASK_MOBILE/app.json" "$TASK_CONFIG_BACKUP"
trap 'cp "$TASK_CONFIG_BACKUP" "$TASK_MOBILE/app.json"; rm -f "$TASK_CONFIG_BACKUP"' EXIT

cd "$TASK_ROOT"
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const api = process.env.EXPO_PUBLIC_API_URL;
const [ready, version] = await Promise.all(['/health/ready', '/version'].map(async path => {
  const response = await fetch(api + path, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Audit API ${path} returned HTTP ${response.status}`);
  return response.json();
}));
const targetSchema = readdirSync('db/migrations').filter(name => /^\d{4}_.*\.sql$/.test(name)).sort().at(-1);
if (ready.status !== 'ready' || ready.env !== 'test' || version.schema !== targetSchema) {
  throw new Error('Audit API is not ready on the expected test schema');
}
const file = 'apps/mobile/app.json';
const config = JSON.parse(readFileSync(file, 'utf8'));
if (config.expo.android.package !== 'app.dawaee.mobile' || config.expo.android.allowBackup !== false) {
  throw new Error('Unexpected source application identity or backup configuration');
}
config.expo.name = 'دوائي — اختبار';
config.expo.scheme = 'dawaee-preview';
config.expo.android.package = 'app.dawaee.mobile.preview';
config.expo.extra.apiBaseUrl = api;
writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
writeFileSync('artifacts/android-preview/build-info.json', JSON.stringify({
  buildKind: 'internal-qa',
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  applicationId: config.expo.android.package,
  apiUrl: api,
  apiCommit: version.commit,
  schema: version.schema,
  integrations: ready.integrations,
  architecture: 'arm64-v8a',
  signing: 'Expo template debug certificate; not a store release',
  nativeDeviceAcceptance: 'NOT_RUN',
  createdAt: new Date().toISOString(),
}, null, 2) + '\n');
NODE

cd "$TASK_MOBILE"
npx --no-install tsc --noEmit
npx --no-install expo prebuild --platform android --no-install
cd android
./gradlew :app:assembleRelease --no-daemon --stacktrace --max-workers=2 \
  -PreactNativeArchitectures=arm64-v8a \
  '-Dorg.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m'

TASK_APK="$TASK_OUTPUT/Dawaee-Android-QA-arm64.apk"
cp app/build/outputs/apk/release/app-release.apk "$TASK_APK"
TASK_BUILD_TOOLS="$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)"
test -x "$TASK_BUILD_TOOLS/apksigner"
"$TASK_BUILD_TOOLS/apksigner" verify --verbose "$TASK_APK" > "$TASK_OUTPUT/signature-check.txt"
"$TASK_BUILD_TOOLS/aapt" dump badging "$TASK_APK" > "$TASK_OUTPUT/apk-badging.txt"
python3 - "$TASK_APK" "$TASK_OUTPUT" <<'PY'
import hashlib, json, sys, zipfile
from pathlib import Path
apk, out = Path(sys.argv[1]), Path(sys.argv[2])
badging = (out / 'apk-badging.txt').read_text()
if "package: name='app.dawaee.mobile.preview'" not in badging:
    raise SystemExit('Unexpected APK application id')
with zipfile.ZipFile(apk) as archive:
    names = set(archive.namelist())
    for name in ('AndroidManifest.xml', 'classes.dex', 'assets/index.android.bundle', 'lib/arm64-v8a/libhermes.so'):
        if name not in names:
            raise SystemExit('Missing native artifact: ' + name)
    if archive.testzip() is not None:
        raise SystemExit('Corrupt APK archive')
digest = hashlib.sha256(apk.read_bytes()).hexdigest()
(out / 'SHA256SUMS').write_text(f'{digest}  {apk.name}\n')
info_file = out / 'build-info.json'
info = json.loads(info_file.read_text())
info.update(apkBytes=apk.stat().st_size, apkSha256=digest, artifactValidation='PASS')
info_file.write_text(json.dumps(info, indent=2, ensure_ascii=False) + '\n')
print(f'Validated installable ARM64 QA APK: {apk.stat().st_size} bytes')
PY

cat > "$TASK_OUTPUT/READ-ME.txt" <<'TEXT'
دوائي — نسخة اختبار Android ARM64

تثبّت هذه النسخة باسم مستقل وبمعرّف app.dawaee.mobile.preview.
تتصل ببيئة التدقيق المعزولة؛ استخدم بيانات اختبار فقط.
لا تحتاج إلى خادم Metro أو لابتوب لتشغيلها بعد التثبيت.
الخدمة التجريبية قد تحتاج وقتًا للاستيقاظ عند أول اتصال.

هذه نسخة QA، وليست إصدار المتجر أو دليلًا على اكتمال الإطلاق.
مزودو الإشعارات وOCR والتخزين في هذه البيئة تجريبيون.
لم يجر إثبات استقبال إشعارات push أو العمل في الخلفية على جهاز فعلي.
ملف build-info.json يثبت إصدار التطبيق وAPI والبصمة والحالة وقت البناء.
TEXT
