# Chojema Image+

A lightweight, fast image viewer for Windows and macOS.

[한국어](README.md)

## Features

- Open a file or folder and browse every image in that folder, sorted by name with numbers in order.
- Fit to window, actual size, zoom, and drag to pan
- Rotate by 90° (view only; the original file is not changed)
- Full screen
- Drag and drop, including several files at once
- Image file associations (open with a double-click)
- Favorite folders (add, remove, rename, reorder) and a recent folders list

## Supported formats

| Format | Windows | macOS |
|---|:---:|:---:|
| JPEG, PNG, GIF, WebP, BMP, ICO, AVIF, SVG | ✓ | ✓ |
| TIFF | ✓ | ✓ |
| HEIC, HEIF | ✓¹ | ✓ |

¹ Requires **HEIF Image Extensions** and **HEVC Video Extensions** from the Microsoft Store. If the Windows Photos app opens HEIC files, they are already installed.

## Install

Download from the [Releases](../../releases) page.

- **Windows**: `ChojemaImagePlus-<version>-windows-x64-setup.exe`
- **macOS**: `ChojemaImagePlus-<version>-macos-universal.dmg` (Apple Silicon and Intel)

Requirements: Windows 10 or later (WebView2), macOS 12 or later

The installers are not code-signed yet, so a warning may appear the first time you run the app.

- **Windows**: In the SmartScreen dialog, click **More info → Run anyway**.
- **macOS**: If the app is blocked on first launch, open **System Settings → Privacy & Security** and click **Open Anyway**.

## Keyboard shortcuts

| Action | Keys |
|---|---|
| Next / previous image | → ↓ PageDown Space / ← ↑ PageUp Backspace |
| First / last image | Home / End |
| Zoom in / out | + / - , Ctrl (⌘) + wheel, trackpad pinch |
| Fit to window / actual size | 0 / 1, double-click |
| Rotate right / left | R / L |
| Full screen / exit | F, F11, Enter / Esc |
| Open file / open folder | Ctrl (⌘) + O / Ctrl (⌘) + Shift + O |
| Add or remove current folder from favorites | Ctrl (⌘) + D |
| Favorites and recent folders | Ctrl (⌘) + B |
| Open favorite 1–9 | Ctrl (⌘) + 1–9 |

The mouse wheel pans when the image is larger than the window, and otherwise moves to the previous or next image.

## Privacy

The app never connects to the network and does not collect or send any information. Favorites and recent folders are stored only in the app's settings folder on this computer.

## License

[MIT](LICENSE) © 2026 Chulwoo Park

Licenses for the open-source software included in the app are listed in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
