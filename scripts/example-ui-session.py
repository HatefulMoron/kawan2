#!/usr/bin/env python3
"""Template: open the dashboard on a headless compositor, then click and shoot.

Run from the repo root: python3 scripts/example-ui-session.py
Delete or copy this file when writing a new check; it is not part of the build.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from uidrive import Session  # noqa: E402


def main() -> int:
    with Session(size="1440x900") as ui:
        # Give the background `kache stats` call time to land.
        ui.sleep(1.5)
        start = ui.shot("start.png")
        print(f"start: {start}")

        # Prefer locating a known colour over guessing coordinates.
        try:
            x, y = ui.locate("#2a63d9")
            print(f"accent at {x},{y}")
            ui.click(x, y)
        except Exception:
            # Fall back to the header refresh button.
            ui.click(1395, 42)

        ui.sleep(0.5)
        print(f"refreshed: {ui.shot('refreshed.png')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
