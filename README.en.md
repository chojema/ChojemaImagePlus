# Chojema Image+

A lightweight, fast image viewer for Windows and macOS.

[한국어](README.md)

## Features

- **List view**: choose a folder in the left-hand tree (favorites, recent folders, locations) to see its images as thumbnails on the right.
  - Sort by name, date modified, or size; adjust thumbnail size
  - Select several images with Ctrl (⌘) or Shift + click and browse only the selection
- **Image view**: double-click a thumbnail or press Enter to view it large; press Esc to return to the list.
  - Fit to window, actual size, zoom, and drag to pan
  - Rotate by 90° (view only; the original file is not changed), full screen
- Favorite folders (add, remove, rename, reorder) and a recent folders list
- Drag and drop, open several files at once, image file associations (open with a double-click)
- Settings: screen shown when the app opens (last folder / empty screen), delete stored thumbnails

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

**List view**

| Action | Keys |
|---|---|
| Move between thumbnails / extend selection | Arrow keys / Shift + arrow keys |
| View large | Enter, Space, double-click |
| Select all | Ctrl (⌘) + A |
| Parent folder | Backspace, Alt + ↑ |
| Refresh | F5 |
| Hide or show sidebar | Ctrl (⌘) + B |
| Settings | Ctrl (⌘) + , |

**Image view**

| Action | Keys |
|---|---|
| Back to list | Esc |
| Next / previous image | → ↓ PageDown Space / ← ↑ PageUp Backspace |
| First / last image | Home / End |
| Zoom in / out | + / - , Ctrl (⌘) + wheel, trackpad pinch |
| Fit to window / actual size | 0 / 1, double-click |
| Rotate right / left | R / L |
| Full screen / exit | F, F11, Enter / Esc |
| Favorites and recent folders | Ctrl (⌘) + B |

**Everywhere**

| Action | Keys |
|---|---|
| Open file / open folder | Ctrl (⌘) + O / Ctrl (⌘) + Shift + O |
| Add or remove current folder from favorites | Ctrl (⌘) + D |
| Open favorite 1–9 | Ctrl (⌘) + 1–9 |

The mouse wheel pans when the image is larger than the window, and otherwise moves to the previous or next image.

## Privacy

The app never connects to the network and does not collect or send any information. Favorites, recent folders, and settings are stored only in the app's settings folder on this computer, and thumbnails only in the app's cache folder.

## License

[MIT](LICENSE) © 2026 Chulwoo Park

Licenses for the open-source software included in the app are listed in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
