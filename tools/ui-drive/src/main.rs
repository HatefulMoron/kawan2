//! `ui-drive` — inject pointer and keyboard input into a Wayland compositor.
//!
//! It speaks the two protocols that let an unprivileged client synthesize
//! input on wlroots compositors (sway, river, Hyprland):
//!
//! - `zwlr_virtual_pointer_manager_v1` for absolute pointer motion, buttons,
//!   drags and scrolling;
//! - `zwp_virtual_keyboard_manager_v1` for key chords and text.
//!
//! Both devices are advertised by the compositor as ordinary seat devices, so
//! the focused client (Kawan) sees normal `wl_pointer`/`wl_keyboard` events.
//! No root, no `/dev/uinput`, no X11, no accessibility API.
//!
//! The tool is a small line protocol on stdin so a caller can interleave input
//! with screenshots: one command per line, one `ok`/`err …` reply per command.
//!
//! ```text
//! move 700 450            absolute pointer position in output pixels
//! click                   left click at the current position
//! click 700 450           move, then left click
//! click 700 450 3         move, then right click
//! down 1 / up 1           press / release a button (1 left, 2 middle, 3 right)
//! drag 100 100 500 400    press at the first point, move, release
//! scroll 3                vertical scroll, positive scrolls down
//! key ctrl+shift+n        a chord; named keysyms and single characters work
//! key Return              named keysyms are case-insensitive
//! type hello@example.com  literal text, one keysym per character
//! sleep 250               milliseconds
//! ```
//!
//! `--extent WxH` declares the coordinate space used by `move`, `click` and
//! `drag`; pass the size of the output being driven.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::os::fd::AsFd;

use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::{wl_registry, wl_seat};
use wayland_client::{Connection, Dispatch, QueueHandle};
use xkbcommon::xkb;

mod protocols {
    pub mod pointer {
        use wayland_client;
        use wayland_client::protocol::*;
        pub mod __interfaces {
            use wayland_client::protocol::__interfaces::*;
            wayland_scanner::generate_interfaces!("protocol/wlr-virtual-pointer-unstable-v1.xml");
        }
        use self::__interfaces::*;
        wayland_scanner::generate_client_code!("protocol/wlr-virtual-pointer-unstable-v1.xml");
    }

    pub mod keyboard {
        use wayland_client;
        use wayland_client::protocol::*;
        pub mod __interfaces {
            use wayland_client::protocol::__interfaces::*;
            wayland_scanner::generate_interfaces!("protocol/virtual-keyboard-unstable-v1.xml");
        }
        use self::__interfaces::*;
        wayland_scanner::generate_client_code!("protocol/virtual-keyboard-unstable-v1.xml");
    }
}

use protocols::keyboard::{
    zwp_virtual_keyboard_manager_v1::ZwpVirtualKeyboardManagerV1,
    zwp_virtual_keyboard_v1::ZwpVirtualKeyboardV1,
};
use protocols::pointer::{
    zwlr_virtual_pointer_manager_v1::ZwlrVirtualPointerManagerV1,
    zwlr_virtual_pointer_v1::ZwlrVirtualPointerV1,
};

const BTN_LEFT: u32 = 0x110;
const BTN_RIGHT: u32 = 0x111;
const BTN_MIDDLE: u32 = 0x112;

/// keystroke modifiers, in the order they are pressed.
const MODIFIER_KEYSYMS: &[(&str, &str)] = &[
    ("ctrl", "Control_L"),
    ("control", "Control_L"),
    ("shift", "Shift_L"),
    ("alt", "Alt_L"),
    ("meta", "Super_L"),
    ("logo", "Super_L"),
    ("super", "Super_L"),
    ("win", "Super_L"),
];

struct Driver {
    pointer: ZwlrVirtualPointerV1,
    keyboard: ZwpVirtualKeyboardV1,
    _keymap: xkb::Keymap,
    state: xkb::State,
    /// keysym -> (xkb keycode, shift level) resolved from the keymap we push
    /// to the compositor.
    syms: HashMap<u32, (u32, u32)>,
    /// Keeps the keymap fd alive for the lifetime of the connection.
    _keymap_file: std::fs::File,
    time: u32,
    extent: (u32, u32),
}

impl Driver {
    fn tick(&mut self) -> u32 {
        let now = self.time;
        self.time = self.time.wrapping_add(8);
        now
    }

    fn send_modifiers(&mut self) {
        let depressed = self.state.serialize_mods(xkb::STATE_MODS_DEPRESSED);
        let latched = self.state.serialize_mods(xkb::STATE_MODS_LATCHED);
        let locked = self.state.serialize_mods(xkb::STATE_MODS_LOCKED);
        let group = 0;
        self.keyboard.modifiers(depressed, latched, locked, group);
    }

    /// Press or release one xkb keycode (the wire protocol uses evdev codes).
    fn key_event(&mut self, keycode: u32, pressed: bool) {
        let time = self.tick();
        let state = u32::from(pressed);
        self.keyboard.key(time, keycode - 8, state);
        let direction = if pressed {
            xkb::KeyDirection::Down
        } else {
            xkb::KeyDirection::Up
        };
        self.state
            .update_key(xkb::Keycode::new(keycode), direction);
        self.send_modifiers();
    }

    fn tap(&mut self, keycode: u32) {
        self.key_event(keycode, true);
        self.key_event(keycode, false);
    }

    fn keycode_of(&self, keysym: u32) -> Result<(u32, u32), String> {
        self.syms
            .get(&keysym)
            .copied()
            .ok_or_else(|| format!("no key produces {}", keysym_name(keysym)))
    }

    /// Tap a keysym, adding Shift (or terminating the chord) as the keymap
    /// requires for that shift level.
    fn tap_symbol(&mut self, keysym: u32) -> Result<(), String> {
        let (keycode, level) = self.keycode_of(keysym)?;
        if level > 1 {
            return Err(format!(
                "{} needs an AltGr-level key, which ui-drive does not model",
                keysym_name(keysym)
            ));
        }
        let shift = level == 1;
        let shift_keycode = if shift {
            Some(self.keycode_of(xkb::Keysym::Shift_L.raw())?.0)
        } else {
            None
        };
        if let Some(code) = shift_keycode {
            self.key_event(code, true);
        }
        self.tap(keycode);
        if let Some(code) = shift_keycode {
            self.key_event(code, false);
        }
        Ok(())
    }

    fn chord(&mut self, spec: &str) -> Result<(), String> {
        let parts: Vec<&str> = spec.split('+').filter(|p| !p.is_empty()).collect();
        let (base, modifiers) = parts.split_last().ok_or("empty key chord")?;

        let mut held: Vec<u32> = Vec::new();
        for modifier in modifiers {
            let name = MODIFIER_KEYSYMS
                .iter()
                .find(|(alias, _)| alias.eq_ignore_ascii_case(modifier))
                .map(|(_, keysym)| *keysym)
                .ok_or_else(|| format!("unknown modifier {modifier:?} in {spec:?}"))?;
            let keysym = parse_keysym(name)?;
            let keycode = self.keycode_of(keysym)?.0;
            self.key_event(keycode, true);
            held.push(keycode);
        }

        let result = self.tap_symbol(parse_keysym(base)?);
        for keycode in held.into_iter().rev() {
            self.key_event(keycode, false);
        }
        result
    }

    fn type_text(&mut self, text: &str) -> Result<(), String> {
        for character in text.chars() {
            let keysym = xkb::utf32_to_keysym(character as u32);
            self.tap_symbol(keysym.raw())
                .map_err(|error| format!("{error} (typing {character:?})"))?;
        }
        Ok(())
    }

    fn move_to(&mut self, x: u32, y: u32) {
        let time = self.tick();
        let (x_extent, y_extent) = self.extent;
        self.pointer
            .motion_absolute(time, x, y, x_extent, y_extent);
        self.frame();
    }

    fn frame(&self) {
        if wayland_client::Proxy::version(&self.pointer) >= 2 {
            self.pointer.frame();
        }
    }

    fn button(&mut self, button: u32, pressed: bool) {
        let time = self.tick();
        self.pointer.button(time, button, u32::from(pressed));
        self.frame();
    }

    fn scroll(&mut self, steps: f64) {
        // Declare a touchpad source first: GPUI treats `axis` as continuous
        // scrolling and ignores it while the source is still its `Wheel`
        // default, so a plain axis event would never reach the app.
        self.pointer
            .axis_source(wayland_client::protocol::wl_pointer::AxisSource::Finger);
        let time = self.tick();
        self.pointer.axis(time, 0, steps * 15.0);
        self.frame();
    }
}

fn parse_keysym(name: &str) -> Result<u32, String> {
    let mut chars = name.chars();
    if let (Some(only), None) = (chars.next(), chars.next()) {
        return Ok(xkb::utf32_to_keysym(only as u32).raw());
    }
    let keysym = xkb::keysym_from_name(name, xkb::KEYSYM_CASE_INSENSITIVE);
    if keysym.raw() == xkb::Keysym::NoSymbol.raw() {
        return Err(format!("unknown key name {name:?}"));
    }
    Ok(keysym.raw())
}

fn keysym_name(keysym: u32) -> String {
    let name = xkb::keysym_get_name(xkb::Keysym::new(keysym));
    if name.is_empty() {
        format!("keysym 0x{keysym:x}")
    } else {
        name
    }
}

fn button_code(button: u32) -> Result<u32, String> {
    match button {
        1 => Ok(BTN_LEFT),
        2 => Ok(BTN_MIDDLE),
        3 => Ok(BTN_RIGHT),
        other => Err(format!("button must be 1 (left), 2 (middle) or 3 (right), got {other}")),
    }
}

/// Everything in a dispatch implementation is uninteresting: ui-drive only
/// creates devices and sends requests.
macro_rules! ignore_events {
    ($interface:ty) => {
        impl Dispatch<$interface, ()> for Driver {
            fn event(
                _: &mut Self,
                _: &$interface,
                _: <$interface as wayland_client::Proxy>::Event,
                _: &(),
                _: &Connection,
                _: &QueueHandle<Self>,
            ) {
            }
        }
    };
}

ignore_events!(wl_seat::WlSeat);
ignore_events!(ZwlrVirtualPointerManagerV1);
ignore_events!(ZwlrVirtualPointerV1);
ignore_events!(ZwpVirtualKeyboardManagerV1);
ignore_events!(ZwpVirtualKeyboardV1);

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for Driver {
    fn event(
        _: &mut Self,
        _: &wl_registry::WlRegistry,
        _: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

fn build_keymap() -> Result<(xkb::Keymap, std::fs::File), String> {
    let context = xkb::Context::new(0);
    let keymap = xkb::Keymap::new_from_names(&context, "", "", "us", "", None, 0)
        .ok_or("xkbcommon could not build a us keymap")?;
    let text = keymap.get_as_string(xkb::KEYMAP_FORMAT_TEXT_V1);

    let dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let path = dir.join(format!("ui-drive-keymap-{}", std::process::id()));
    std::fs::write(&path, text.as_bytes()).map_err(|error| error.to_string())?;
    let file = std::fs::File::open(&path).map_err(|error| error.to_string())?;
    let _ = std::fs::remove_file(&path);
    Ok((keymap, file))
}

fn syms_table(keymap: &xkb::Keymap) -> HashMap<u32, (u32, u32)> {
    let mut table: HashMap<u32, (u32, u32)> = HashMap::new();
    let layouts = keymap.num_layouts();
    for keycode in 8u32..=255 {
        for layout in 0..layouts {
            for level in 0u32..=3 {
                let syms = keymap.key_get_syms_by_level(xkb::Keycode::new(keycode), layout, level);
                for sym in syms {
                    table.entry(sym.raw()).or_insert((keycode, level));
                }
            }
        }
    }
    table
}

struct Args {
    extent: (u32, u32),
}

fn parse_args() -> Result<Args, String> {
    let mut extent = (1920u32, 1080u32);
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--extent" => {
                let raw = args.next().ok_or("--extent needs WxH")?;
                let (width, height) = raw
                    .split_once(['x', 'X'])
                    .ok_or_else(|| format!("bad extent {raw:?}, expected WxH"))?;
                extent = (
                    width.parse().map_err(|_| format!("bad width in {raw:?}"))?,
                    height.parse().map_err(|_| format!("bad height in {raw:?}"))?,
                );
            }
            "-h" | "--help" => {
                println!("usage: ui-drive [--extent WxH] < commands");
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    Ok(Args { extent })
}

fn main() {
    if let Err(error) = run() {
        eprintln!("ui-drive: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = parse_args()?;

    let connection = Connection::connect_to_env().map_err(|error| error.to_string())?;
    let (globals, mut queue) =
        registry_queue_init::<Driver>(&connection).map_err(|error| error.to_string())?;
    let handle = queue.handle();

    let seat: wl_seat::WlSeat = globals
        .bind(&handle, 1..=9, ())
        .map_err(|_| "the compositor exposes no wl_seat".to_string())?;
    let pointer_manager: ZwlrVirtualPointerManagerV1 = globals
        .bind(&handle, 1..=2, ())
        .map_err(|_| "the compositor does not support zwlr_virtual_pointer".to_string())?;
    let keyboard_manager: ZwpVirtualKeyboardManagerV1 = globals
        .bind(&handle, 1..=1, ())
        .map_err(|_| "the compositor does not support zwp_virtual_keyboard".to_string())?;

    let (keymap, keymap_file) = build_keymap()?;
    let state = xkb::State::new(&keymap);
    let text_len = keymap.get_as_string(xkb::KEYMAP_FORMAT_TEXT_V1).len() as u32;

    let mut driver = Driver {
        pointer: pointer_manager.create_virtual_pointer(Some(&seat), &handle, ()),
        keyboard: keyboard_manager.create_virtual_keyboard(&seat, &handle, ()),
        syms: syms_table(&keymap),
        _keymap: keymap,
        state,
        _keymap_file: keymap_file,
        time: 0,
        extent: args.extent,
    };
    // The keymap must be in place before any key event, and the file must stay
    // readable for as long as the compositor needs it.
    let keymap_fd = driver._keymap_file.as_fd();
    driver.keyboard.keymap(1, keymap_fd, text_len);
    connection.flush().map_err(|error| error.to_string())?;
    queue
        .roundtrip(&mut driver)
        .map_err(|error| error.to_string())?;

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| error.to_string())?;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let outcome = execute(&mut driver, trimmed);
        connection.flush().map_err(|error| error.to_string())?;
        match outcome {
            Ok(()) => writeln!(stdout, "ok").map_err(|error| error.to_string())?,
            Err(error) => writeln!(stdout, "err {error}").map_err(|error| error.to_string())?,
        }
        stdout.flush().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn execute(driver: &mut Driver, line: &str) -> Result<(), String> {
    let mut words = line.splitn(2, char::is_whitespace);
    let command = words.next().unwrap_or_default();
    let rest = words.next().unwrap_or_default().trim();
    let numbers = || -> Result<Vec<u32>, String> {
        rest.split_whitespace()
            .map(|word| {
                word.parse::<u32>()
                    .map_err(|_| format!("expected a number, got {word:?}"))
            })
            .collect()
    };

    match command {
        "move" => {
            let values = numbers()?;
            let [x, y] = values[..] else {
                return Err("move needs X Y".to_string());
            };
            driver.move_to(x, y);
        }
        "click" => {
            let values = numbers()?;
            let (x, y, button) = match values[..] {
                [] => (None, None, 1),
                [button] => (None, None, button),
                [x, y] => (Some(x), Some(y), 1),
                [x, y, button] => (Some(x), Some(y), button),
                _ => return Err("click takes [X Y] [BUTTON]".to_string()),
            };
            if let (Some(x), Some(y)) = (x, y) {
                driver.move_to(x, y);
            }
            let code = button_code(button)?;
            driver.button(code, true);
            driver.button(code, false);
        }
        "down" | "up" => {
            let button = numbers()?.first().copied().unwrap_or(1);
            let code = button_code(button)?;
            driver.button(code, command == "down");
        }
        "drag" => {
            let values = numbers()?;
            let (from_x, from_y, to_x, to_y, button) = match values[..] {
                [fx, fy, tx, ty] => (fx, fy, tx, ty, 1),
                [fx, fy, tx, ty, button] => (fx, fy, tx, ty, button),
                _ => return Err("drag needs X1 Y1 X2 Y2 [BUTTON]".to_string()),
            };
            let code = button_code(button)?;
            driver.move_to(from_x, from_y);
            driver.button(code, true);
            let steps = 8;
            for step in 1..=steps {
                let x = from_x + (to_x as i64 - from_x as i64) as u32 * step / steps;
                let y = from_y + (to_y as i64 - from_y as i64) as u32 * step / steps;
                driver.move_to(x, y);
            }
            driver.button(code, false);
        }
        "scroll" => {
            let steps: f64 = rest
                .parse()
                .map_err(|_| format!("scroll needs a number, got {rest:?}"))?;
            driver.scroll(steps);
        }
        "key" => driver.chord(rest)?,
        "type" => driver.type_text(rest)?,
        "sleep" => {
            let millis: u64 = rest
                .parse()
                .map_err(|_| format!("sleep needs milliseconds, got {rest:?}"))?;
            std::thread::sleep(std::time::Duration::from_millis(millis));
        }
        other => return Err(format!("unknown command {other:?}")),
    }
    Ok(())
}
