"""Native UI acceptance, not a mock: ADB touches + accessibility tree + real API.

Only synthetic accounts at the hard-coded isolated preview. Credentials remain
in memory. Screenshots/video start after login; no logcat or token dumps.
"""
import json
import os
import re
import secrets
import subprocess
import time
import urllib.error
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path

assert os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("DAWAEE_DEVICE_CI") == "1"
BASE = "http://127.0.0.1:8080"
PACKAGE = "app.dawaee.audit"
OUT = Path("android-interaction-evidence")
RESULTS = []
WIDTH, HEIGHT = 720, 1280
SEEN = set()
AUTHENTICATED = False


def adb(*args, binary=False, timeout=35):
    # Do not echo command arguments: input text can contain a test password.
    # Command family is useful; values/stderr/TimeoutExpired.cmd are sensitive.
    family = " ".join(args[:3]) if args[:1] == ("shell",) else args[0]
    try:
        result = subprocess.run(["adb", *args], capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise AssertionError("ADB " + family + " timed out (values withheld)") from None
    if result.returncode:
        raise AssertionError("ADB " + family + " failed, exit " + str(result.returncode) + " (values withheld)")
    return result.stdout if binary else result.stdout.decode(errors="replace")


def api(path, body=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(BASE + path, headers=headers,
        data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(request, timeout=50) as response:
            assert response.status == 200
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise AssertionError("API HTTP " + str(error.code) + " at " + path.split("?")[0]) from None


def create_account(email, password, name, device):
    seeded = subprocess.run(["node", "--import", "tsx", "scripts/android-interaction/fixture.mts", "seed"],
        input=json.dumps({"email": email, "password": password, "displayName": name}),
        text=True, capture_output=True, timeout=30)
    assert seeded.returncode == 0, "disposable fixture creation failed (details withheld)"
    return api("/v1/auth/login", {"identifier": email, "password": password, "deviceId": device})


def tree():
    # The first activity/frame can be between windows during launch. Retry only
    # this read, never a tap, save, registration or other state-changing action.
    for attempt in range(5):
        try:
            dumped = adb("shell", "uiautomator", "dump", "/sdcard/audit-window.xml", timeout=12)
            assert "dumped to:" in dumped, "Android window dump was not produced; refusing a stale tree"
            raw = adb("shell", "cat", "/sdcard/audit-window.xml", timeout=5)
            nodes = list(ET.fromstring(raw).iter("node"))
            assert nodes, "Android window has no accessibility nodes"
            for node in nodes:
                SEEN.update([node.get("text", ""), node.get("content-desc", "")])
            return nodes
        except (AssertionError, ET.ParseError, subprocess.TimeoutExpired):
            if attempt == 4:
                raise
            time.sleep(1)


def bounds(node):
    values = list(map(int, re.findall(r"\d+", node.get("bounds", ""))))
    assert len(values) == 4, "missing UI bounds"
    return values


def matches(node, label, prefix=False):
    values = [node.get("text", ""), node.get("content-desc", ""), node.get("resource-id", "")]
    return any(value.startswith(label) if prefix else value == label for value in values)


def visible(node):
    x1, y1, x2, y2 = bounds(node)
    return x2 > x1 and y2 > y1 and 0 <= x1 < x2 <= WIDTH and 0 <= y1 < y2 <= HEIGHT


def locate(label, prefix=False, field=False, scroll=False, upward=False, attempts=25):
    for _ in range(attempts):
        candidates = [n for n in tree() if matches(n, label, prefix) and visible(n)
            and (not field or n.get("class") == "android.widget.EditText")]
        if candidates:
            enabled = [n for n in candidates if n.get("enabled") != "false"]
            if enabled:
                # Prefer the accessible action, not its child text.
                return next((n for n in enabled if n.get("clickable") == "true"), enabled[0])
        if scroll:
            swipe(upward=upward)
        else:
            time.sleep(0.5)
    raise AssertionError("UI control unavailable: " + label)


def touch(node):
    x1, y1, x2, y2 = bounds(node)
    adb("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))


def tap(label, **kwargs):
    touch(locate(label, **kwargs))


def swipe(upward=False, x=None, top=None, bottom=None):
    x = x if x is not None else WIDTH // 2
    top = top if top is not None else int(HEIGHT * .30)
    bottom = bottom if bottom is not None else int(HEIGHT * .73)
    start, end = (top, bottom) if upward else (bottom, top)
    adb("shell", "input", "swipe", str(x), str(start), str(x), str(end), "400")


def fill(label, value, prefix=False):
    assert re.fullmatch(r"[A-Za-z0-9@_.+-]+", value), "only generated ASCII test input"
    touch(locate(label, prefix=prefix, field=True, scroll=True))
    # End is a visual caret operation in an RTL editor. Clear both directions
    # instead of assuming it placed the caret after the existing value.
    adb("shell", "input", "keyevent", *( ["KEYCODE_DEL"] * 70))
    adb("shell", "input", "keyevent", *( ["KEYCODE_FORWARD_DEL"] * 70))
    verify_amount = label.startswith("كمية الجرعة")
    if verify_amount:
        assert locate(label, prefix=prefix, field=True).get("text", "") == "", "dose editor did not clear"
    adb("shell", "input", "text", value)
    if verify_amount:
        assert locate(label, prefix=prefix, field=True).get("text") == value, "dose editor differs from requested test input"
    adb("shell", "input", "keyevent", "4")  # close the keyboard


def capture(name):
    (OUT / (name + ".png")).write_bytes(adb("exec-out", "screencap", "-p", binary=True))
    # Clinical fixture values only. Called exclusively after synthetic login.
    adb("shell", "uiautomator", "dump", "/sdcard/audit-window.xml")
    (OUT / (name + ".xml")).write_text(adb("shell", "cat", "/sdcard/audit-window.xml"))


def pass_result(case, detail):
    RESULTS.append({"case": case, "status": "PASS", "detail": detail})
    print("PASS " + case + ": " + detail, flush=True)


def choose_column(title, value):
    label = title + ": " + value
    for _ in range(45):
        nodes = tree()
        found = next((n for n in nodes if matches(n, label) and visible(n)), None)
        if found is not None:
            touch(found)
            return
        column = next((n for n in nodes if n.get("scrollable") == "true" and matches(n, title)), None)
        assert column is not None, "time column is not scrollable: " + title
        x1, y1, x2, y2 = bounds(column)
        swipe(x=(x1+x2)//2, top=y1+40, bottom=y2-40)
    raise AssertionError("cannot reach time option " + label)


def pick(index, hour, minute):
    tap("الأوقات " + str(index) + ":", prefix=True, scroll=True)
    locate("تم", attempts=5)
    choose_column("الساعة (24 ساعة)", hour)
    choose_column("الدقائق", minute)
    tap("تم")
    locate("الأوقات " + str(index) + ": " + hour + ":" + minute, attempts=5)


def scenario(case, width, height, density, font):
    global WIDTH, HEIGHT, AUTHENTICATED
    WIDTH, HEIGHT = width, height
    AUTHENTICATED = False
    SEEN.clear()
    adb("shell", "am", "force-stop", PACKAGE)
    adb("shell", "pm", "clear", PACKAGE)  # only the disposable CI installation
    adb("shell", "pm", "grant", PACKAGE, "android.permission.POST_NOTIFICATIONS")
    adb("shell", "wm", "size", str(width) + "x" + str(height))
    adb("shell", "wm", "density", str(density))
    adb("shell", "settings", "put", "system", "font_scale", str(font))
    identity = uuid.uuid4().hex
    email = "native-" + identity + "@example.invalid"
    password = secrets.token_hex(20) + "A9"
    tokens = create_account(email, password, "SyntheticAndroid", "ci-" + identity)
    token = tokens["accessToken"]
    profile = api("/v1/profiles", token=token)["profiles"][0]["id"]
    launch = adb("shell", "cmd", "package", "resolve-activity", "--brief",
        "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-p", PACKAGE)
    activity = next((line.strip() for line in launch.splitlines() if line.strip().startswith(PACKAGE + "/")), None)
    assert activity, "isolated app has no resolved launcher activity"
    started = adb("shell", "am", "start", "-W", "-n", activity)
    assert "Status: ok" in started, "Android did not finish launching the isolated activity"
    tap("العربية")
    fill("رقم الجوال أو البريد الإلكتروني", email)
    fill("كلمة المرور", password)
    tap("دخول")
    tap("إضافة دواء", scroll=True)
    AUTHENTICATED = True
    tap("إدخال يدوي.", prefix=True, scroll=True)
    locate("اسم الدواء", field=True)
    fill("اسم الدواء", "SyntheticTablet")
    fill("كمية الجرعة في كل مرة", "6", prefix=True)
    capture(case + "-quantity")
    tap("الأوقات 1:", prefix=True, scroll=True)
    locate("تم", attempts=5)
    capture(case + "-picker-open")
    # Hardware Back dismisses without committing; repeat catches stuck overlays.
    for _ in range(3):
        choose_column("الساعة (24 ساعة)", "01")
        adb("shell", "input", "keyevent", "4")
        tap("الأوقات 1: 08:00")
    tap("إلغاء")
    locate("الأوقات 1: 08:00", attempts=5)
    pass_result(case, "three hardware Back cycles and Cancel retain 08:00")
    recording = subprocess.Popen(["adb", "shell", "screenrecord", "--time-limit", "180",
        "/sdcard/interaction.mp4"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        pick(1, "23", "59")
        capture(case + "-time-2359")
        for index, hour in [(2, "00"), (3, "06"), (4, "12")]:
            tap("إضافة وقت", scroll=True)
            pick(index, hour, "00")
        pass_result(case, "both columns reach 23:59; four independently selected times")
        fill("الكمية الحالية", "60", prefix=True)
        tap("حفظ", scroll=True)
        # Saved form navigates to medication details, which has this action.
        locate("تعديل", scroll=True)
        capture(case + "-saved")
        meds = api("/v1/medications?profileId=" + profile, token=token)["medications"]
        assert len(meds) == 1, "save created wrong medication count"
        detail = api("/v1/medications/" + meds[0]["id"], token=token)
        schedule = detail["schedules"][0]
        stock = api("/v1/medications/" + meds[0]["id"] + "/stock", token=token)["stock"]
        # Evidence contains only the synthetic fixture, never account/session IDs.
        persisted = {"doseQuantity": schedule["doseQuantity"], "doseUnit": schedule["doseUnit"],
            "times": schedule["rule"]["times"], "weekdays": schedule["rule"]["weekdays"],
            "remainingQuantity": stock["remainingQuantity"], "stockUnit": stock["unit"]}
        (OUT / (case + "-persisted.json")).write_text(json.dumps(persisted, indent=2))
        assert persisted["doseQuantity"] == 6 and persisted["doseUnit"] == "tablet", "saved quantity/unit mismatch"
        assert persisted["times"] == ["00:00", "06:00", "12:00", "23:59"], "saved times mismatch"
        assert persisted["weekdays"] == list(range(7)), "saved weekdays mismatch"
        assert persisted["remainingQuantity"] == 60 and persisted["stockUnit"] == "tablet", "saved stock mismatch"
        pass_result(case, "UI save persisted quantity 6, tablet unit, 4 times, 7 days and stock 60")
    finally:
        subprocess.run(["adb", "shell", "pkill", "-INT", "screenrecord"],
            capture_output=True, timeout=10, check=False)
        recording.wait(timeout=10)
        adb("pull", "/sdcard/interaction.mp4", str(OUT / (case + "-interaction.mp4")))


def main():
    assert os.environ.get("GITHUB_ACTIONS") == "true", "CI emulator only"
    assert os.environ.get("EXPO_PUBLIC_API_URL") == BASE
    devices = adb("devices")
    assert re.search(r"^emulator-\d+\s+device$", devices, re.M), "no emulator"
    assert len(re.findall(r"\sdevice$", devices, re.M)) == 1, "ambiguous device selection"
    version = None
    for attempt in range(3):
        try:
            version = api("/version")
            break
        except (urllib.error.URLError, TimeoutError, AssertionError, json.JSONDecodeError):
            if attempt == 2:
                raise
            time.sleep(5)
    assert version["commit"] == os.environ["AUDIT_API_COMMIT"], "backend commit mismatch; no writes"
    assert api("/health/ready")["status"] == "ready"
    (OUT / "backend-version.json").write_text(json.dumps(version, indent=2))
    (OUT / "device.txt").write_text(adb("shell", "getprop", "ro.build.fingerprint"))
    failed = False
    for case, width, height, density, font in [
        ("small-ar", 720, 1280, 320, 1.0),
        ("large-ar-font200", 1080, 2400, 420, 2.0),
    ]:
        try:
            scenario(case, width, height, density, font)
        except Exception as error:
            RESULTS.append({"case": case, "status": "FAIL", "reason": str(error)})
            # Avoid collecting a potentially visible credential at failed login.
            if AUTHENTICATED:
                capture(case + "-failed")
            print("FAIL " + case + ": " + str(error), flush=True)
            failed = True
    assert not failed, "Native scenarios failed; see results.json and interaction evidence"


if __name__ == "__main__":
    try:
        main()
    finally:
        OUT.mkdir(exist_ok=True)
        (OUT / "results.json").write_text(json.dumps({"results": RESULTS,
            "limits": ["emulator only; physical phone NOT VERIFIED", "no real SMS, OCR or Push",
                       "gesture navigation and offline sync NOT VERIFIED"]}, ensure_ascii=False, indent=2))
