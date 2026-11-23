#!/usr/bin/env python3
"""Headless E2E verification of Kawan v1 desktop UI via scripts/uidrive.py."""

import json
import os
import select
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from uidrive import Session, UiDriveError  # noqa: E402


def locate_optional(ui: Session, *args, **kwargs):
    try:
        return ui.locate(*args, **kwargs)
    except UiDriveError:
        return None


def wait_for_host_info(proc: subprocess.Popen[str], timeout_sec: float = 20.0) -> dict:
    deadline = time.monotonic() + timeout_sec
    assert proc.stdout is not None
    fd = proc.stdout.fileno()
    buf = ""
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            err = proc.stderr.read() if proc.stderr else ""
            raise RuntimeError(f"ui-e2e-host exited early ({proc.returncode}): {err}")
        remaining = max(0.05, deadline - time.monotonic())
        r, _, _ = select.select([fd], [], [], min(0.5, remaining))
        if not r:
            continue
        chunk = os.read(fd, 4096).decode("utf-8")
        if not chunk:
            continue
        buf += chunk
        if "\n" in buf:
            line = buf.splitlines()[0].strip()
            return json.loads(line)
    raise TimeoutError("Timed out waiting for ui-e2e-host startup JSON")


def run_git(repo_dir: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", repo_dir, *args],
        capture_output=True,
        text=True,
        timeout=10,
    )


def replace_field(ui: Session, value: str) -> None:
    ui.key("ctrl+u")
    if value:
        ui.type(value)


def main() -> int:
    # Ensure client reads clean defaults unless configured via the UI
    for var in ("KAWAN_MOCK", "KAWAN_HOST_URL", "KAWAN_BOOTSTRAP_TOKEN", "KAWAN_SSH_KEY"):
        os.environ.pop(var, None)

    binary = ROOT / "target" / "debug" / "kawan"
    if not binary.exists():
        raise FileNotFoundError(f"Missing binary {binary}; run `cargo build` first")

    host_proc = subprocess.Popen(
        ["npx", "tsx", "test/ui-e2e-host.ts"],
        cwd=str(ROOT / "host"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    try:
        info = wait_for_host_info(host_proc, timeout_sec=25.0)
        url = info["url"]
        bootstrap_token = info["bootstrap_token"]
        repo_bare_path = info["repo_bare_path"]
        stub_llm_url = info["stub_llm_url"]
        stub_decision_url = info["stub_decision_url"]
        admin_key_path = info["admin_key_path"]
        initial_head = info["initial_head"]
        data_dir = info["data_dir"]
        host_bare_repo = str(Path(data_dir) / "repo.git")
        allowed_signers = str(Path(data_dir) / "allowed_signers")

        with Session(
            size="1440x900",
            fullscreen=True,
            warmup=1.5,
            timeout=120.0,
            build=False,
        ) as ui:
            # 1. Connect screen -> focus window by clicking card title, fill bootstrap fields
            ui.shot("/tmp/v1-01-connect.png")
            ui.click(720, 275)  # Focus window without shifting ConnectHost target
            replace_field(ui, url)
            ui.key("Tab")
            replace_field(ui, bootstrap_token)
            ui.key("Tab")
            replace_field(ui, "alice")
            ui.key("Tab")
            replace_field(ui, admin_key_path)
            ui.key("Return")
            ui.sleep(1.5)

            # 2. Checklist screen -> open Step 01 Repository settings
            ui.shot("/tmp/v1-02-checklist.png")
            ui.click(1020, 405)
            ui.sleep(0.5)

            # 3. Repository Settings
            replace_field(ui, repo_bare_path)
            ui.key("Tab")
            replace_field(ui, "main")
            ui.key("Tab")
            replace_field(ui, "test -f land_ok.txt")
            save_repo = ui.locate("#102015", tolerance=12, region=(900, 340, 1280, 760), minimum=200)
            if not save_repo:
                ui.shot("/tmp/v1-03-settings-repo.png")
                raise RuntimeError("Could not locate Save Repository button")
            ui.click(*save_repo)
            ui.sleep(1.5)
            ui.shot("/tmp/v1-03-settings-repo.png")

            # 4. Models Settings
            ui.click(575, 74)  # Models tab
            ui.sleep(0.3)
            replace_field(ui, "stub")
            ui.key("Tab")
            replace_field(ui, stub_llm_url)
            ui.key("Tab")
            replace_field(ui, "stub-model")
            ui.key("Tab")
            replace_field(ui, "stub-key")
            ui.key("Tab")
            replace_field(ui, stub_decision_url)
            ui.key("Tab")
            replace_field(ui, "stub-snap")
            ui.key("Tab")
            replace_field(ui, "stub-key")
            save_models = ui.locate("#102015", tolerance=12, region=(900, 420, 1280, 860), minimum=200)
            ui.click(*save_models)
            ui.sleep(1.0)
            # Banner shifts card down once Settings saved appears; re-locate footer y for Test Models
            save_models_after = ui.locate("#102015", tolerance=12, region=(900, 420, 1280, 860), minimum=200)
            ui.click(502, save_models_after[1])  # Test Models button on left side of footer
            ui.sleep(1.2)
            ui.shot("/tmp/v1-04-settings-models.png")

            # 5. Bots Settings
            ui.click(670, 74)  # Bots & Invites tab
            ui.sleep(0.3)
            replace_field(ui, "kawan")
            ui.key("Tab")
            replace_field(ui, "Practical engineering orchestrator. Always delegate via spawn_session.")
            ui.key("Tab")
            replace_field(ui, "")  # default model role
            ui.key("Tab")
            replace_field(ui, "off")
            create_bot = ui.locate("#102015", tolerance=12, region=(900, 380, 1280, 890), minimum=200)
            ui.click(*create_bot)
            ui.sleep(1.5)
            ui.shot("/tmp/v1-05-settings-bots.png")

            # 6. Open #general via left rail
            ui.click(120, 102)
            ui.sleep(0.6)
            ui.shot("/tmp/v1-06-general-empty.png")

            # 7. Add @kawan to #general
            ui.click(1075, 52)  # + Add member
            ui.sleep(0.4)
            ui.shot("/tmp/v1-06b-add-member.png")
            ui.click(626, 105)  # @kawan pill in add-member strip
            ui.sleep(0.6)

            # 8. Send prompt in composer and wait for APPROVE LAND button
            ui.click(700, 828)
            ui.sleep(0.2)
            ui.type("@kawan please create land_ok.txt containing ready, commit it, and request land")
            ui.key("Return")

            approve_pos = None
            deadline = time.monotonic() + 45.0
            while time.monotonic() < deadline:
                approve_pos = locate_optional(
                    ui, "#102015", tolerance=12, region=(880, 120, 1250, 770), minimum=400
                )
                if approve_pos:
                    break
                ui.sleep(1.0)

            ui.shot("/tmp/v1-07-land-requested.png")
            if not approve_pos:
                raise TimeoutError("Timed out waiting for APPROVE LAND button to appear")

            # 9. Click APPROVE LAND and verify git bare repo advances with signed commit
            ui.click(*approve_pos)

            new_head = None
            land_deadline = time.monotonic() + 20.0
            while time.monotonic() < land_deadline:
                res = run_git(host_bare_repo, "rev-parse", "refs/heads/main")
                if res.returncode == 0:
                    cand = res.stdout.strip()
                    if cand and cand != initial_head:
                        new_head = cand
                        break
                ui.sleep(0.5)

            ui.sleep(0.6)
            ui.shot("/tmp/v1-08-landed.png")

            # 10. Open @kawan DM to verify Tasks UX panel
            ui.click(100, 166)
            ui.sleep(0.5)
            ui.shot("/tmp/v1-09-bot-dm-tasks.png")

            if not new_head:
                raise RuntimeError(f"refs/heads/main never advanced from {initial_head}")

            parent = run_git(host_bare_repo, "rev-parse", "refs/heads/main^")
            assert parent.returncode == 0, parent.stderr
            assert parent.stdout.strip() == initial_head, f"Expected parent {initial_head}, got {parent.stdout.strip()}"

            blob = run_git(host_bare_repo, "show", "refs/heads/main:land_ok.txt")
            assert blob.returncode == 0, blob.stderr
            assert blob.stdout.strip() == "ready", f"Expected 'ready', got {blob.stdout!r}"

            verify = run_git(
                host_bare_repo,
                "-c",
                "gpg.format=ssh",
                "-c",
                f"gpg.ssh.allowedSignersFile={allowed_signers}",
                "verify-commit",
                "refs/heads/main",
            )
            assert verify.returncode == 0, f"verify-commit failed: {verify.stderr}"

            print(
                json.dumps(
                    {
                        "status": "PASS",
                        "initial_head": initial_head,
                        "landed_head": new_head,
                        "land_ok_txt": blob.stdout.strip(),
                    }
                )
            )
            return 0
    finally:
        host_proc.terminate()
        try:
            host_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            host_proc.kill()
            host_proc.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
