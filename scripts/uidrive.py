#!/usr/bin/env python3
"""Drive the Kawan UI on a throwaway, off-screen Wayland compositor.

One import gives a test session that can type, click, and screenshot without
ever touching the developer's display or window manager:

    from uidrive import Session

    with Session(size="1440x900") as session:
        session.shot("start.png")
        session.click(820, 40)               # the panel "Refresh" button
        session.shot("refreshed.png")

The same steps can be written as a small script (see ``--script`` below), which
is the intended template for agents::

    # open, let the first stats fetch land, capture
    shot start.png
    sleep 1500
    shot settled.png

How it fits together: ``Session`` starts ``sway`` with ``WLR_BACKENDS=headless``
(no DRM device, no seat, no window anywhere), launches the app there with Mesa
lavapipe (software Vulkan), and feeds input through ``tools/ui-drive``, which
synthesizes events with the wlr virtual-pointer and virtual-keyboard protocols.
Screenshots come from ``grim`` over ``wlr-screencopy``. Everything runs in a
private ``XDG_RUNTIME_DIR``, so a session can never be attached to a running
desktop session.

``kawan`` shells out to ``kache``; the session inherits the caller's ``PATH``,
``HOME`` and kache cache directory, so it shows the real cache numbers.
Set ``KAWAN_UI_SKIP_KACHE=1`` to run with an empty ``PATH`` for kache instead
(the dashboard then renders its error state).

Requirements: ``sway`` and ``grim`` on PATH (``sudo apt install sway grim``),
Mesa's lavapipe driver, and ``libxkbcommon`` for ``ui-drive``.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import zlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
UI_DRIVE_MANIFEST = REPO_ROOT / "tools" / "ui-drive" / "Cargo.toml"
DEFAULT_SIZE = "1440x900"
LAVAPIPE_ICD = Path("/usr/share/vulkan/icd.d/lvp_icd.x86_64.json")
LAVAPIPE_ICD_FALLBACK = Path("/usr/share/vulkan/icd.d/lvp_icd.json")


class UiDriveError(RuntimeError):
    """The session could not start, or a step failed."""


def _which(name: str, override: str | None = None) -> str:
    found = shutil.which(override or name)
    if not found:
        raise UiDriveError(
            f"{name} not found. Install it (sudo apt install sway grim) "
            f"or point an environment variable at it."
        )
    return found


def _target_dir() -> Path:
    out = subprocess.run(
        ["cargo", "metadata", "--manifest-path", str(REPO_ROOT / "Cargo.toml"),
         "--no-deps", "--format-version", "1"],
        cwd=REPO_ROOT, capture_output=True, text=True, check=True,
    ).stdout
    return Path(json.loads(out)["target_directory"])


def _build(manifest: Path, package: str | None, target_dir: Path) -> None:
    command = ["cargo", "build", "--manifest-path", str(manifest), "--target-dir", str(target_dir)]
    if package:
        command += ["-p", package]
    result = subprocess.run(command, cwd=REPO_ROOT, capture_output=True, text=True)
    if result.returncode != 0:
        raise UiDriveError(f"cargo build failed:\n{result.stderr}")


def _decode_png(path: Path) -> tuple[int, int, int, bytes]:
    """Decode a non-interlaced 8-bit PNG into ``(width, height, channels, rows)``.

    Only the four colour types grim can emit are supported. This exists so the
    session can inspect its own captures without pulling in an image library.
    """
    data = path.read_bytes()
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise UiDriveError(f"{path} is not a PNG")
    offset, idat = 8, bytearray()
    width = height = depth = colour = interlace = 0
    while offset < len(data):
        length = int.from_bytes(data[offset:offset + 4], "big")
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:offset + 8 + length]
        if kind == b"IHDR":
            width = int.from_bytes(payload[0:4], "big")
            height = int.from_bytes(payload[4:8], "big")
            depth = payload[8]
            colour = payload[9]
            interlace = payload[12]
        elif kind == b"IDAT":
            idat += payload
        elif kind == b"IEND":
            break
        offset += 12 + length
    channels = {0: 1, 2: 3, 4: 2, 6: 4}.get(colour)
    if depth != 8 or channels is None or interlace != 0:
        raise UiDriveError(
            f"{path}: unsupported PNG (depth {depth}, colour type {colour}, "
            f"interlace {interlace})"
        )
    stride = width * channels
    raw = zlib.decompress(bytes(idat))
    out = bytearray(height * stride)
    previous = bytearray(stride)
    position = 0
    for row in range(height):
        filter_type = raw[position]
        position += 1
        line = bytearray(raw[position:position + stride])
        position += stride
        if filter_type == 1:
            for index in range(channels, stride):
                line[index] = (line[index] + line[index - channels]) & 0xFF
        elif filter_type == 2:
            for index in range(stride):
                line[index] = (line[index] + previous[index]) & 0xFF
        elif filter_type == 3:
            for index in range(stride):
                left = line[index - channels] if index >= channels else 0
                line[index] = (line[index] + ((left + previous[index]) >> 1)) & 0xFF
        elif filter_type == 4:
            for index in range(stride):
                left = line[index - channels] if index >= channels else 0
                up = previous[index]
                upleft = previous[index - channels] if index >= channels else 0
                estimate = left + up - upleft
                distances = (abs(estimate - left), abs(estimate - up), abs(estimate - upleft))
                if distances[0] <= distances[1] and distances[0] <= distances[2]:
                    predictor = left
                elif distances[1] <= distances[2]:
                    predictor = up
                else:
                    predictor = upleft
                line[index] = (line[index] + predictor) & 0xFF
        elif filter_type != 0:
            raise UiDriveError(f"{path}: unknown PNG row filter {filter_type}")
        out[row * stride:(row + 1) * stride] = line
        previous = line
    return width, height, channels, bytes(out)


def _is_blank_png(path: Path) -> bool:
    """Guard against the "captured a black window" failure mode."""
    try:
        width, height, channels, pixels = _decode_png(path)
    except UiDriveError:
        return True
    if not pixels:
        return True
    first = pixels[:channels]
    step = max(1, (width * height) // 4096)
    for index in range(0, width * height, step):
        offset = index * channels
        if pixels[offset:offset + channels] != first:
            return False
    return True


class Session:
    """A running app on a private headless compositor."""

    def __init__(
        self,
        *,
        size: str = DEFAULT_SIZE,
        binary: str | Path | None = None,
        args: list[str] | tuple[str, ...] = (),
        fullscreen: bool = True,
        keep: bool = False,
        warmup: float = 2.0,
        timeout: float = 60.0,
        verbose: bool = False,
        build: bool = True,
    ) -> None:
        self.size = size
        self.width, self.height = (int(part) for part in size.lower().split("x"))
        self.binary = Path(binary) if binary else None
        self.app_args = list(args)
        self.fullscreen = fullscreen
        self.keep = keep
        self.warmup = warmup
        self.timeout = timeout
        self.verbose = verbose
        self.build = build

        self.sway_bin = _which("sway", os.environ.get("KAWAN_UI_SWAY"))
        self.swaymsg_bin = _which("swaymsg", os.environ.get("KAWAN_UI_SWAYMSG"))
        self.grim_bin = _which("grim", os.environ.get("KAWAN_UI_GRIM"))

        self._sway: subprocess.Popen | None = None
        self._app: subprocess.Popen | None = None
        self._driver: subprocess.Popen | None = None
        self._run_dir: Path | None = None
        self._logs: list = []
        self.swaysock: Path | None = None
        self._output = "HEADLESS-1"
        self._shot_count = 0

    # -- lifecycle ---------------------------------------------------------
    def __enter__(self) -> "Session":
        try:
            self.start()
        except BaseException:
            self.stop()
            raise
        return self

    def __exit__(self, *_exc) -> None:
        self.stop()

    def _log(self, message: str) -> None:
        if self.verbose:
            print(f"uidrive: {message}", file=sys.stderr)

    def start(self) -> None:
        target_dir = _target_dir()
        if self.binary is None:
            if self.build:
                self._log("building kawan")
                _build(REPO_ROOT / "Cargo.toml", "kawan", target_dir)
            self.binary = target_dir / "debug" / "kawan"
        if not Path(self.binary).exists():
            raise UiDriveError(f"no app binary at {self.binary}")
        if self.build:
            self._log("building ui-drive")
            _build(UI_DRIVE_MANIFEST, None, target_dir)
        driver_bin = target_dir / "debug" / "ui-drive"
        if not driver_bin.exists():
            raise UiDriveError(f"no ui-drive binary at {driver_bin}")

        run_dir = Path(tempfile.mkdtemp(prefix="uidrive."))
        run_dir.chmod(0o700)
        self._run_dir = run_dir

        sway_config = run_dir / "sway.conf"
        sway_config.write_text(
            f"output {self._output} resolution {self.size}\n"
            f"output {self._output} bg #101014 solid_color\n"
            "default_border none\n"
            "default_floating_border none\n"
            "gaps inner 0\n"
            "gaps outer 0\n"
        )

        self._log(f"starting headless sway on {self.size}")
        self._sway = self._spawn(
            [
                self.sway_bin, "--unsupported-gpu", "-c", str(sway_config),
            ],
            extra_env={
                "WLR_BACKENDS": "headless",
                "WLR_HEADLESS_OUTPUTS": "1",
                "WLR_LIBINPUT_NO_DEVICES": "1",
                "WLR_RENDERER": "pixman",
                "XDG_SESSION_TYPE": "wayland",
            },
            log=run_dir / "sway.log",
        )
        self.swaysock = run_dir / f"sway-ipc.{os.getuid()}.{self._sway.pid}.sock"

        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            if (run_dir / self.display).exists():
                break
            if self._sway.poll() is not None:
                raise UiDriveError(f"sway exited:\n{self._text(run_dir / 'sway.log')}")
            time.sleep(0.05)
        else:
            raise UiDriveError("the headless compositor did not start")

        self._log(f"running {self.binary}")
        vulkan_icd = os.environ.get("VK_ICD_FILENAMES")
        if not vulkan_icd:
            for candidate in (LAVAPIPE_ICD, LAVAPIPE_ICD_FALLBACK):
                if candidate.exists():
                    vulkan_icd = str(candidate)
                    break
        app_env = {
            # Render through Mesa's software Vulkan so a capture needs no GPU
            # and no window appears on the developer's display.
            "VK_ICD_FILENAMES": vulkan_icd or "",
            "LIBGL_ALWAYS_SOFTWARE": "1",
            "GPUI_X11_SCALE_FACTOR": "1",
            "WINIT_X11_SCALE_FACTOR": "1",
        }
        if os.environ.get("KAWAN_UI_SKIP_KACHE"):
            app_env["PATH"] = str(run_dir / "empty-path")
            Path(app_env["PATH"]).mkdir()
        self._app = self._spawn(
            [str(self.binary), *self.app_args],
            extra_env=app_env,
            log=run_dir / "app.log",
        )
        self._wait_for_window()

        if self.fullscreen:
            self.swaymsg(f"[pid={self._app.pid}] fullscreen enable")

        self._driver = subprocess.Popen(
            [str(driver_bin), "--extent", self.size],
            cwd=REPO_ROOT,
            env=self._env(),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self._command("sleep 1")
        if self.warmup:
            time.sleep(self.warmup)

    def stop(self) -> None:
        for process in (self._driver, self._app, self._sway):
            if process is None or process.poll() is not None:
                continue
            for signal_number in (signal.SIGTERM, signal.SIGKILL):
                try:
                    process.send_signal(signal_number)
                    process.wait(timeout=5)
                    break
                except (subprocess.TimeoutExpired, ProcessLookupError):
                    continue
        self._driver = self._app = self._sway = None

        if self._run_dir is not None:
            # The UI spawns its daemon as a child, and the daemon outlives the
            # UI, so take down anything still pointing into this scratch dir.
            # The `--` matters: without it pkill reads "--socket ..." as an
            # option and kills nothing.
            subprocess.run(
                ["pkill", "-f", "--", str(self._run_dir)],
                capture_output=True, check=False,
            )
            for handle in self._logs:
                handle.close()
            self._logs.clear()
            if self.keep:
                print(f"uidrive: kept {self._run_dir}", file=sys.stderr)
            else:
                shutil.rmtree(self._run_dir, ignore_errors=True)
            self._run_dir = None

    # -- plumbing ----------------------------------------------------------
    @property
    def display(self) -> str:
        return "wayland-1"

    def _env(self) -> dict[str, str]:
        env = {k: v for k, v in os.environ.items() if k not in {"DISPLAY", "WAYLAND_SOCKET"}}
        env["WAYLAND_DISPLAY"] = self.display
        env["XDG_RUNTIME_DIR"] = str(self._run_dir)
        env["XDG_SESSION_TYPE"] = "wayland"
        if self.swaysock is not None:
            env["SWAYSOCK"] = str(self.swaysock)
        return env

    def _spawn(self, command: list[str], *, extra_env: dict[str, str], log: Path) -> subprocess.Popen:
        env = self._env()
        env.update({k: v for k, v in extra_env.items() if v})
        handle = log.open("wb")
        self._logs.append(handle)
        return subprocess.Popen(
            command, cwd=REPO_ROOT, env=env, stdout=handle, stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    @staticmethod
    def _text(path: Path) -> str:
        try:
            return path.read_text(errors="replace").strip()
        except OSError:
            return ""

    def _sway_tree(self) -> dict:
        result = subprocess.run(
            [self.swaymsg_bin, "-t", "get_tree"],
            env=self._env(), capture_output=True, text=True,
        )
        if result.returncode != 0:
            raise UiDriveError(f"swaymsg failed: {result.stderr.strip()}")
        return json.loads(result.stdout)

    def _wait_for_window(self) -> None:
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            if self._app.poll() is not None:
                raise UiDriveError(f"the app exited before opening a window:\n{self.log()}")
            try:
                if self._find_window(self._sway_tree(), self._app.pid):
                    return
            except UiDriveError:
                pass  # the sway IPC socket may not be up yet
            time.sleep(0.1)
        raise UiDriveError(f"no app window after {self.timeout:g}s:\n{self.log()}")

    @staticmethod
    def _find_window(node: dict, pid: int | None = None) -> dict | None:
        if pid is not None and node.get("pid") == pid:
            return node
        for child in node.get("nodes", []) + node.get("floating_nodes", []):
            found = Session._find_window(child, pid)
            if found:
                return found
        return None

    def _command(self, line: str) -> None:
        if self._driver is None or self._driver.poll() is not None:
            raise UiDriveError("the input driver is not running")
        try:
            self._driver.stdin.write(line + "\n")
            self._driver.stdin.flush()
            reply = self._driver.stdout.readline().strip()
        except (BrokenPipeError, ValueError) as error:
            raise UiDriveError(
                f"the input driver stopped while running {line!r}: {error}"
            ) from error
        if not reply:
            raise UiDriveError(f"the input driver stopped while running {line!r}")
        if reply != "ok":
            raise UiDriveError(f"{line!r} failed: {reply}")


    # -- observations ------------------------------------------------------
    def swaymsg(self, criteria_or_command: str) -> str:
        """Run a sway IPC command, e.g. ``fullscreen enable``."""
        result = subprocess.run(
            [self.swaymsg_bin, criteria_or_command],
            env=self._env(), capture_output=True, text=True,
        )
        return result.stdout.strip()

    def window_rect(self) -> tuple[int, int, int, int]:
        """The app window as ``(x, y, width, height)`` in output pixels."""
        node = self._find_window(self._sway_tree(), self._app.pid if self._app else None)
        if not node:
            raise UiDriveError("the app window is gone")
        rect = node["rect"]
        return rect["x"], rect["y"], rect["width"], rect["height"]

    def log(self) -> str:
        if self._run_dir is None:
            return ""
        return self._text(self._run_dir / "app.log")

    def shot(self, path: str | Path | None = None, *, check: bool = True) -> Path:
        """Capture the output to ``path`` and return it.

        ``check`` refuses to return an unpainted (uniform) image, which is what
        a crashed render or a missing window looks like.
        """
        if self._run_dir is None:
            raise UiDriveError("the session is not running")
        if path is None:
            self._shot_count += 1
            target = Path(f"kawan-ui-{self._shot_count}.png")
        else:
            target = Path(path)
        self._capture(target)
        if check and _is_blank_png(target):
            raise UiDriveError(
                f"{target} is blank: the app painted nothing (see app log below)\n"
                f"{self.log()}"
            )
        return target

    def _capture(self, target: Path) -> Path:
        if self._run_dir is None:
            raise UiDriveError("the session is not running")
        target.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            [self.grim_bin, "-o", self._output, str(target)],
            env=self._env(), capture_output=True, text=True,
        )
        if result.returncode != 0:
            raise UiDriveError(f"grim failed: {result.stderr.strip()}")
        return target

    def locate(
        self,
        colour: str | tuple[int, int, int],
        *,
        tolerance: int = 12,
        region: tuple[int, int, int, int] | None = None,
        minimum: int = 64,
    ) -> tuple[int, int]:
        """Centre of the largest region painted in ``colour`` in the last capture.

        Button colours move when layout changes, so prefer locating a control
        over hard-coding a guess: ``x, y = session.locate("#3b6fd4")`` returns
        the centre of the biggest accent-coloured blob on screen.
        """
        if isinstance(colour, str):
            text = colour.lstrip("#")
            target = tuple(int(text[index:index + 2], 16) for index in (0, 2, 4))
        else:
            target = tuple(colour)
        path = self._capture(Path(self._run_dir) / "locate.png")
        try:
            width, height, channels, pixels = _decode_png(path)
            if channels < 3:
                raise UiDriveError("locate() needs an RGB or RGBA capture")
            x0, y0, x1, y1 = region or (0, 0, width, height)
            cells: dict[tuple[int, int], list[int]] = {}
            for y in range(y0, min(y1, height)):
                row = y * width * channels
                for x in range(x0, min(x1, width)):
                    offset = row + x * channels
                    if (
                        abs(pixels[offset] - target[0]) <= tolerance
                        and abs(pixels[offset + 1] - target[1]) <= tolerance
                        and abs(pixels[offset + 2] - target[2]) <= tolerance
                    ):
                        cell = (x // 8, y // 8)
                        entry = cells.get(cell)
                        if entry is None:
                            cells[cell] = [x, y, x, y, 1]
                        else:
                            entry[0] = min(entry[0], x)
                            entry[1] = min(entry[1], y)
                            entry[2] = max(entry[2], x)
                            entry[3] = max(entry[3], y)
                            entry[4] += 1
        finally:
            path.unlink(missing_ok=True)

        best: tuple[int, int, int, int, int] | None = None
        seen: set[tuple[int, int]] = set()
        for cell in cells:
            if cell in seen:
                continue
            seen.add(cell)
            stack = [cell]
            start = cells[cell]
            x_min, y_min, x_max, y_max, count = start
            count = 0
            while stack:
                current = stack.pop()
                entry = cells[current]
                count += entry[4]
                x_min, y_min = min(x_min, entry[0]), min(y_min, entry[1])
                x_max, y_max = max(x_max, entry[2]), max(y_max, entry[3])
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        neighbour = (current[0] + dx, current[1] + dy)
                        if neighbour in cells and neighbour not in seen:
                            seen.add(neighbour)
                            stack.append(neighbour)
            blob = (x_min, y_min, x_max, y_max, count)
            if best is None or blob[4] > best[4]:
                best = blob
        if best is None or best[4] < minimum:
            raise UiDriveError(f"no region matching {colour!r} in the capture")
        return ((best[0] + best[2]) // 2, (best[1] + best[3]) // 2)

    # -- input -------------------------------------------------------------
    def command(self, line: str) -> None:
        """Send a raw ``ui-drive`` command."""
        self._command(line)

    def move(self, x: int, y: int) -> None:
        self._command(f"move {int(x)} {int(y)}")

    def click(self, x: int | None = None, y: int | None = None, button: int = 1) -> None:
        self._command(
            f"click {int(button)}" if x is None else f"click {int(x)} {int(y)} {int(button)}"
        )

    def down(self, button: int = 1) -> None:
        self._command(f"down {int(button)}")

    def up(self, button: int = 1) -> None:
        self._command(f"up {int(button)}")

    def drag(self, x1: int, y1: int, x2: int, y2: int, button: int = 1) -> None:
        self._command(f"drag {int(x1)} {int(y1)} {int(x2)} {int(y2)} {int(button)}")

    def scroll(self, steps: int) -> None:
        self._command(f"scroll {int(steps)}")

    def key(self, chord: str) -> None:
        """Tap a chord such as ``ctrl+shift+n``, ``Return`` or ``Escape``."""
        self._command(f"key {chord}")

    def type(self, text: str) -> None:
        """Type literal text (ASCII; the driver's keymap is a US layout)."""
        self._command(f"type {text}")

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)
        # Let the app repaint before the next observation.
        self._command(f"sleep {max(1, int(seconds * 1000))}")

    def run(self, steps: str | list[str]) -> None:
        """Run a block of DSL steps."""
        for line in steps.splitlines() if isinstance(steps, str) else steps:
            self.step(line)

    def step(self, line: str) -> None:
        """Run one DSL step."""
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            return
        verb, _, rest = stripped.partition(" ")
        rest = rest.strip()

        def numbers(*allowed: int, what: str) -> list[int]:
            values = [int(part) for part in rest.split()]
            if len(values) not in allowed:
                raise UiDriveError(
                    f"{verb} expects {what}, got {rest!r}"
                )
            return values

        if verb == "shot":
            print(self.shot(rest or None), flush=True)
        elif verb == "move":
            self.move(*numbers(2, what="X Y"))
        elif verb == "click":
            values = numbers(0, 1, 2, 3, what="[X Y] [BUTTON]")
            if len(values) == 0:
                self.click()
            elif len(values) == 1:
                self.click(button=values[0])
            else:
                self.click(values[0], values[1], values[2] if len(values) == 3 else 1)
        elif verb in ("down", "up"):
            values = numbers(0, 1, what="[BUTTON]")
            (self.down if verb == "down" else self.up)(values[0] if values else 1)
        elif verb == "drag":
            values = numbers(4, 5, what="X1 Y1 X2 Y2 [BUTTON]")
            self.drag(*values[:4], values[4] if len(values) == 5 else 1)
        elif verb == "scroll":
            self.scroll(*numbers(1, what="STEPS"))
        elif verb == "key":
            self.key(rest)
        elif verb == "type":
            self.type(rest)
        elif verb == "sleep":
            self._command(f"sleep {int(rest)}")
        elif verb == "wait":
            self.sleep(float(rest))
        else:
            raise UiDriveError(f"unknown step {verb!r}")


USAGE = """\
usage: uidrive.py [options] [OUT.png]

  -o, --out OUT.png      where to write the screenshot (default kawan-ui.png)
  -s, --size WxH         output size (default 1440x900)
      --script FILE      run a DSL script (- for stdin)
      --steps TEXT       run DSL steps given inline, separated by ';'
  -f, --frames N         capture N screenshots instead of one
  -i, --interval SEC     seconds between frame captures
      --warmup SEC       settle time after the window appears (default 2)
  -t, --timeout SEC      how long to wait for the window (default 60)
      --windowed         do not fullscreen the app
      --keep             keep the scratch directory for debugging
  -b, --bin PATH         run this binary instead of building -p kawan
      --no-build         use the existing binary, do not run cargo
  -v, --verbose          chatter on stderr
  -h, --help             this text

DSL steps (one per line, '#' comments):
  shot [NAME.png]        capture the output
  click X Y [BUTTON]     move and click (1 left, 2 middle, 3 right)
  move X Y               move the pointer
  down [BUTTON] / up [BUTTON]
  drag X1 Y1 X2 Y2 [BUTTON]
  scroll STEPS           positive scrolls down
  key ctrl+shift+n       a chord; named keysyms such as Return also work
  type TEXT              literal text (US layout)
  sleep MS               pause in milliseconds
  wait SEC               pause in seconds
"""


def main(argv: list[str]) -> int:
    options = {
        "out": None, "size": DEFAULT_SIZE, "script": None, "steps": None,
        "frames": 1, "interval": 0.5, "warmup": 2.0, "timeout": 60.0,
        "fullscreen": True,
        "keep": False,
        "binary": None, "build": True, "verbose": False,
    }
    positional: list[str] = []
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg in ("-h", "--help"):
            print(USAGE, end="")
            return 0
        if arg in ("-o", "--out"):
            index += 1
            options["out"] = argv[index]
        elif arg in ("-s", "--size"):
            index += 1
            options["size"] = argv[index]
        elif arg == "--script":
            index += 1
            options["script"] = argv[index]
        elif arg == "--steps":
            index += 1
            options["steps"] = argv[index]
        elif arg in ("-f", "--frames"):
            index += 1
            options["frames"] = int(argv[index])
        elif arg in ("-i", "--interval"):
            index += 1
            options["interval"] = float(argv[index])
        elif arg == "--warmup":
            index += 1
            options["warmup"] = float(argv[index])
        elif arg in ("-t", "--timeout"):
            index += 1
            options["timeout"] = float(argv[index])
        elif arg == "--windowed":
            options["fullscreen"] = False
        elif arg == "--keep":
            options["keep"] = True
        elif arg in ("-b", "--bin"):
            index += 1
            options["binary"] = argv[index]
        elif arg == "--no-build":
            options["build"] = False
        elif arg in ("-v", "--verbose"):
            options["verbose"] = True
        elif arg.startswith("-"):
            print(f"uidrive: unknown option {arg!r}\n\n{USAGE}", file=sys.stderr, end="")
            return 2
        else:
            positional.append(arg)
        index += 1

    if positional and options["out"] is None:
        options["out"] = positional[0]

    try:
        with Session(
            size=options["size"],
            binary=options["binary"],
            fullscreen=options["fullscreen"],
            keep=options["keep"],
            warmup=options["warmup"],
            timeout=options["timeout"],
            verbose=options["verbose"],
            build=options["build"],
        ) as session:
            if options["script"]:
                text = (
                    sys.stdin.read() if options["script"] == "-"
                    else Path(options["script"]).read_text()
                )
                session.run(text)
                return 0
            if options["steps"]:
                session.run([part for part in options["steps"].split(";")])
                return 0
            out = Path(options["out"] or "kawan-ui.png")
            if options["frames"] > 1:
                for frame in range(1, options["frames"] + 1):
                    print(session.shot(out.with_name(f"{out.stem}-{frame}{out.suffix}")))
                    if frame < options["frames"]:
                        session.sleep(options["interval"])
            else:
                print(session.shot(out))
        return 0
    except UiDriveError as error:
        print(f"uidrive: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
