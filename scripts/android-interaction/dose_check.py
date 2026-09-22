"""Native confirm/undo/retake: API only sets up synthetic fixtures and reads back.

No dose action is sent by the API helper. Test data lives only in the isolated
preview; credentials and logcat are never recorded.
"""
import json
import os
import secrets
import subprocess
import time
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import check as ui


def launch():
    resolved = ui.adb("shell", "cmd", "package", "resolve-activity", "--brief",
        "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-p", ui.PACKAGE)
    activity = next((s.strip() for s in resolved.splitlines() if s.strip().startswith(ui.PACKAGE + "/")), None)
    assert activity, "no isolated launcher"
    assert "Status: ok" in ui.adb("shell", "am", "start", "-W", "-n", activity), "launch did not complete"


def confirmed_card(name):
    for _ in range(25):
        for node in ui.tree():
            label = node.get("content-desc", "")
            if label.startswith(name) and "تم أخذه" in label and ui.visible(node):
                return
        ui.swipe()
    raise AssertionError("confirmed dose card is not visible")


def scenario(case, tracked):
    ui.WIDTH, ui.HEIGHT = 720, 1280
    ui.AUTHENTICATED = False
    ui.adb("shell", "am", "force-stop", ui.PACKAGE)
    ui.adb("shell", "pm", "clear", ui.PACKAGE)
    ui.adb("shell", "pm", "grant", ui.PACKAGE, "android.permission.POST_NOTIFICATIONS")
    ui.adb("shell", "wm", "size", "720x1280")
    ui.adb("shell", "wm", "density", "320")
    ui.adb("shell", "settings", "put", "system", "font_scale", "1.0")
    identity = uuid.uuid4().hex
    email = "native-dose-" + identity + "@example.invalid"
    password = secrets.token_hex(20) + "A9"
    tokens = ui.create_account(email, password, "SyntheticDose", "ci-" + identity)
    token = tokens["accessToken"]
    profile = ui.api("/v1/profiles", token=token)["profiles"][0]
    today_path = "/v1/today?profileId=" + profile["id"]
    clock = ui.api(today_path, token=token)
    now = datetime.fromisoformat(clock["serverTime"].replace("Z", "+00:00")).astimezone(ZoneInfo(clock["timezone"]))
    date, at = now.strftime("%Y-%m-%d"), now.strftime("%H:%M")
    name = "AmberFixture" if tracked else "VioletSample"
    payload = {"clientRequestId": str(uuid.uuid4()), "patientProfileId": profile["id"],
        "name": name, "form": "tablet", "startDate": date,
        "schedule": {"rule": {"kind": "days_of_week", "weekdays": list(range(7)), "times": [at]},
            "doseQuantity": 6, "doseUnit": "tablet", "timezone": clock["timezone"], "startDate": date}}
    if tracked:
        payload["stock"] = {"trackingEnabled": True, "initialQuantity": 60,
            "unit": "tablet", "lowStockThresholdDays": 7}
    medication = ui.api("/v1/medications", payload, token=token)["medication"]
    stock_path = "/v1/medications/" + medication["id"] + "/stock"
    launch()
    ui.tap("العربية")
    ui.fill("رقم الجوال أو البريد الإلكتروني", email)
    ui.fill("كلمة المرور", password)
    ui.tap("دخول")
    ui.locate("أخذت الدواء", scroll=True)
    ui.AUTHENTICATED = True
    doses = ui.api(today_path, token=token)["today"]
    assert len(doses) == 1 and doses[0]["medicationId"] == medication["id"], "ambiguous dose fixture"
    ui.capture(case + "-before")
    ledger_checks = []

    def saved(taken, quantity):
        for attempt in range(10):
            rows = ui.api(today_path, token=token)["today"]
            assert len(rows) == 1, "dose count changed"
            is_taken = rows[0]["status"] in ["taken", "taken_late"]
            if is_taken == taken:
                break
            assert attempt < 9, "server dose state differs from native action"
            time.sleep(1)
        state = ui.api(stock_path, token=token)
        if tracked:
            assert state["stock"]["remainingQuantity"] == quantity, "inventory differs from native action"
            assert state["stock"]["unit"] == "tablet", "inventory unit changed"
        else:
            assert state["stock"] is None and state["transactions"] == [], "untracked medication changed inventory"
        ledger_checks.append({"status": rows[0]["status"],
            "remainingQuantity": state["stock"]["remainingQuantity"] if state["stock"] else None})
        return state

    recording = subprocess.Popen(["adb", "shell", "screenrecord", "--time-limit", "180", "/sdcard/dose-interaction.mp4"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ui.tap("أخذت الدواء")
        ui.locate("تراجع", scroll=True)
        saved(True, 54)
        ui.capture(case + "-taken")
        ui.tap("تراجع")
        ui.locate("أخذت الدواء", scroll=True, upward=True)
        saved(False, 60)
        ui.tap("أخذت الدواء")
        ui.locate("تراجع", scroll=True)
        state = saved(True, 54)
        movements = [t for t in reversed(state["transactions"]) if t["reason"] in ["dose_taken", "dose_undone"]]
        if tracked:
            assert [t["delta"] for t in movements] == [-6, 6, -6], "dose movements duplicated or missing"
            assert [t["balanceAfter"] for t in movements] == [54, 60, 54], "ledger balances differ"
        ui.adb("shell", "am", "force-stop", ui.PACKAGE)
        launch()  # preserve data/session; actually restart the native process
        confirmed_card(name)
        saved(True, 54)
        ui.capture(case + "-reopened")
        ui.tap("السجل")
        confirmed_card(name)
        ui.capture(case + "-history")
        (ui.OUT / (case + "-persisted.json")).write_text(json.dumps({"tracked": tracked,
            "checks": ledger_checks, "ledgerDeltas": [t["delta"] for t in movements]}, indent=2))
        ui.pass_result(case, "native take/undo/retake, inventory, process restart and history agree")
    finally:
        subprocess.run(["adb", "shell", "pkill", "-INT", "screenrecord"], capture_output=True, timeout=10, check=False)
        recording.wait(timeout=10)
        ui.adb("pull", "/sdcard/dose-interaction.mp4", str(ui.OUT / (case + "-interaction.mp4")))


def main():
    assert os.environ.get("GITHUB_ACTIONS") == "true"
    assert os.environ.get("EXPO_PUBLIC_API_URL") == ui.BASE
    assert ui.api("/version")["commit"] == os.environ["AUDIT_API_COMMIT"], "unexpected backend; no writes"
    devices = ui.adb("devices")
    assert "emulator-" in devices and len([s for s in devices.splitlines() if s.endswith("\tdevice")]) == 1
    failed = False
    for case, tracked in [("dose-tracked", True), ("dose-untracked", False)]:
        try:
            scenario(case, tracked)
        except Exception as error:
            ui.RESULTS.append({"case": case, "status": "FAIL", "reason": str(error)})
            if ui.AUTHENTICATED:
                ui.capture(case + "-failed")
            print("FAIL " + case + ": " + str(error), flush=True)
            failed = True
    assert not failed, "Native dose scenarios failed; see dose-results.json"


if __name__ == "__main__":
    try:
        main()
    finally:
        (ui.OUT / "dose-results.json").write_text(json.dumps({"results": ui.RESULTS,
            "limits": ["emulator only", "real push and offline synchronization NOT VERIFIED"]}, ensure_ascii=False, indent=2))
