# kawan

A small [GPUI](https://github.com/gpui-ce/gpui-ce) desktop dashboard for the
[kache](https://github.com/kunobi-ninja/kache) compiler cache. It runs
`kache stats --json` every few seconds and renders hit rate, hits/misses, entry
count, time saved, and store usage.

## Setup

```sh
# GPUI system dependencies (Ubuntu / Debian)
sudo apt-get install -y libxkbcommon-dev libxkbcommon-x11-dev libwayland-dev \
  libx11-dev libxcb-shape0-dev libxcb-xfixes0-dev libfontconfig-dev

# kache (v2 installs kache, kache-engine and the C/C++ shims)
cargo install kache --locked
kache init          # machine-wide cargo wiring, service, completions
kache doctor --probe

cargo run
```

`.cargo/config.toml` sets `build.rustc-wrapper = "kache"`, so this crate's own
builds are cached even without a global `kache init`. kache must be on `PATH`.

## Looking at the UI without a window

`scripts/ui-shot` renders the app on a throwaway headless `sway` compositor
(software Vulkan, `grim` capture) so nothing appears on the desktop:

```sh
scripts/ui-shot                       # -> ./kawan-ui.png at 1440x900
scripts/ui-shot --windowed -s 900x600 -o /tmp/ui.png
scripts/uidrive.py --steps "sleep 1500; click 1373 56; shot /tmp/after.png"
```

`scripts/uidrive.py` also exposes a Python `Session` (`shot`, `click`, `type`,
`key`, `scroll`, `locate`) for scripted checks; see `AGENTS.md` and
`scripts/example-ui-session.py`. Requires `sway`, `grim`, and
`mesa-vulkan-drivers` (`sudo apt install sway grim`).
