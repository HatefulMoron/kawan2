# Agent notes

Repo-specific instructions for coding agents working on this GPUI dashboard.

## Looking at the UI: only through `scripts/`

Never take screenshots of, or send input to, the developer's real display, and
never start the app on the current `WAYLAND_DISPLAY`/`DISPLAY` to look at it.
Starting it on the live session pops a window over the developer's work and
makes every capture depend on their window manager.

Everything below runs on a throwaway headless `sway` compositor in a scratch
directory, renders with software Vulkan (lavapipe), and captures with `grim`.
No window appears on screen.

```
scripts/ui-shot                              # -> ./kawan-ui.png (1440x900)
scripts/ui-shot -o /tmp/ui.png --frames 4 --interval 2
scripts/ui-shot --size 1280x800 --windowed
```

For states that need interaction, use the step DSL or the Python session; do
not hand-roll input injection:

```
scripts/uidrive.py --steps "sleep 1500; shot settled.png"
scripts/uidrive.py --script /tmp/steps.txt
python3 scripts/example-ui-session.py        # template: locate, click, shot
```

- One step per line: `shot NAME.png`, `click X Y [BUTTON]`, `move X Y`,
  `down`/`up [BUTTON]`, `drag X1 Y1 X2 Y2`, `scroll N`, `key ctrl+shift+n`,
  `type TEXT`, `sleep MS`, `wait SEC`. `shot` prints the path it wrote.
- Python API equivalent: `with Session() as ui:` then `ui.shot()`, `ui.click()`,
  `ui.type()`, `ui.key()`, `ui.locate("#2a63d9", region=...)`.
- **Click first, then use the keyboard.** The window never takes initial focus,
  so `key`/`type` do nothing on a freshly opened window.
- Coordinates are output pixels at the session size (default `1440x900`, app
  fullscreen). Changing `--size` or `--windowed` moves them.
- `type` is ASCII on a US layout.
- Read the PNGs with your image tool. They are for review, not for a gate.
- The dashboard shells out to `kache` every 5 seconds; give the first fetch a
  moment (`sleep 1500`) before the first `shot`, or capture the loading state
  deliberately. `KAWAN_UI_SKIP_KACHE=1 scripts/ui-shot` hides `kache` from
  `PATH` to render the error state instead.
- Friendly default: `--keep` keeps the scratch directory and prints its path;
  `app.log` and `sway.log` there explain a window that never appeared.

- First run also builds `-p kawan` and `tools/ui-drive`; `--no-build` skips
  both if you already built. `cargo` and `kache` must be on `PATH`
  (`source ~/.cargo/env`).
- Full option list: `scripts/uidrive.py --help`.

If `sway`/`grim` are missing: `sudo apt install sway grim` (lavapipe comes with
`mesa-vulkan-drivers`).

## Builds

This crate builds through kache (`.cargo/config.toml` sets
`build.rustc-wrapper = "kache"`), so repeated builds and clean rebuilds of the
GPUI dependency tree are cheap. Keep `kache` installed and on `PATH`; without
it Cargo fails with "could not execute process `kache`".

## Gates

`cargo fmt`, `cargo clippy --all-targets -- -D warnings`, and `cargo test`
must stay clean. `tools/ui-drive` is a standalone crate with its own
`[workspace]` table: it is a development tool and must not be added as a
workspace member or as a dependency of the app.
