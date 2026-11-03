# Chojema Image+

A lightweight, fast image viewer for Windows and macOS.

[한국어](README.md)

## Features

- **List view**: choose a folder in the left-hand tree (favorites, recent folders, locations) to see its images as thumbnails on the right.
  - Folders with tens of thousands of images open at once; thumbnails on screen are made first and the rest are prepared in the background.
  - The list updates automatically when other programs add or remove files in the folder.
  - Sort by name, date modified, or size; adjust thumbnail size
  - Select several images with Ctrl (⌘) or Shift + click and browse only the selection
- **Image view**: double-click a thumbnail or press Enter to view it large; press Esc to return to the list.
  - Fit to window, actual size, zoom, and drag to pan
  - Rotate by 90° (view only; the original file is not changed), full screen
- **Side-by-side compare**: select 2 to 4 thumbnails and click Compare or press C.
  - 2 images side by side or stacked, 3 in a row, 4 in a 2×2 grid
  - Keep zoom and position in step across panes (the same area is shown even at different resolutions); rotate or close each pane
- **Move or copy to another folder**: drag selected thumbnails onto a folder, favorite, recent folder, or the path bar on the left, or use the Move/Copy button (M) to pick a folder.
  - You choose move or copy each time; when a file with the same name exists you choose keep both (rename), replace, or skip.
  - Pair files with the same name (RAW+JPEG, .xmp, Live Photo videos, …) can go along, and are renamed to match when the image is renamed.
  - Replaced files go to the trash, and the last operation can be undone with Ctrl (⌘) + Z.
- **Dual pane** (F6): split the list into two panes, side by side or top and bottom, to work with two folders at once.
  - Drag thumbnails from one pane to the other, or press M, to move or copy them to the other pane's folder.
  - Switch panes with Tab; the folder tree and favorites open in the active pane (blue underline).
- **Move to Trash**: send selected images to the Trash (Recycle Bin on Windows) with the trash button, the Delete key (⌘ + Backspace on macOS), or the right-click menu. Pair files can go along; in the image view the next image is shown afterwards.
- **Right-click menu**: view, compare side by side, move or copy to another folder, show in Finder (File Explorer), move to Trash
- **Slideshow** (S or the play button): choose the folder and whether to include subfolders, the order (list sort order / random), images smaller than the window (original size / enlarge) and larger (shrink / original size), the interval, what to show (current date and time, file name, position), looping, and full screen. Settings are remembered.
- **Export to another format** (Ctrl/⌘ + E or right-click): JPEG, PNG, WebP, AVIF, HEIC (macOS), TIFF, BMP
  - Quality, size (original / long side / scale), photo information (keep / remove location only / remove all), background for transparent areas
  - Destination (subfolder of the source folder / same folder / other pane / another folder) and text added to file names
  - Photo orientation is applied to the pixels and the originals are never changed; you are asked about name conflicts.
- Favorite folders (add, remove, rename, reorder) and a recent folders list
- Drag and drop, open several files at once, image file associations (open with a double-click)
- Settings: interface language (follow system / 한국어 / English), screen shown when the app opens (last folder / empty screen), delete stored thumbnails

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
| Compare 2–4 selected images | C |
| Move or copy selected images to another folder | M (to the other pane in dual mode), drag onto a folder |
| Dual pane on/off / switch pane | F6 / Tab |
| Undo the last move or copy | Ctrl (⌘) + Z |
| Move selected images to the Trash | Delete, ⌘ + Backspace (macOS) |
| Slideshow | S |
| Export selected images to another format | Ctrl (⌘) + E |
| Parent folder | Backspace, Alt + ↑ |
| Refresh | F5 |
| Hide or show sidebar | Ctrl (⌘) + B |
| Settings | Ctrl (⌘) + , |

**Image view**

| Action | Keys |
|---|---|
| Back to list | Esc |
| Move the current image to the Trash | Delete, ⌘ + Backspace (macOS) |
| Next / previous image | → ↓ PageDown Space / ← ↑ PageUp Backspace |
| First / last image | Home / End |
| Zoom in / out | + / - , Ctrl (⌘) + wheel, trackpad pinch |
| Fit to window / actual size | 0 / 1, double-click |
| Rotate right / left | R / L |
| Full screen / exit | F, F11, Enter / Esc |
| Favorites and recent folders | Ctrl (⌘) + B |

**Compare view**

| Action | Keys |
|---|---|
| Back to list | Esc |
| Zoom in / out | + / - , wheel, trackpad pinch |
| Fit all / all at actual size | 0 / 1 |
| Keep zoom and position in step on/off | S |
| Side by side / stacked (2 images) | V |
| Select next pane | Tab |
| Rotate / close selected pane | R, L / Delete |
| Full screen | F |

**Slideshow**

| Action | Keys |
|---|---|
| Pause / resume | Space, click |
| Previous / next image | ← / → |
| Full screen | F |
| Stop | Esc |

**Everywhere**

| Action | Keys |
|---|---|
| Open file / open folder | Ctrl (⌘) + O / Ctrl (⌘) + Shift + O |
| Add or remove current folder from favorites | Ctrl (⌘) + D |
| Open favorite 1–9 | Ctrl (⌘) + 1–9 |

The mouse wheel pans when the image is larger than the window, and otherwise moves to the previous or next image.

## Privacy

The app never connects to the network and does not collect or send any information. Favorites, recent folders, and settings are stored only in the app's settings folder on this computer, and thumbnails only in the app's cache folder.

## Links

- GitHub repository: https://github.com/chojema/ChojemaImagePlus
- Chojema App Park: https://chojema.github.io/AppPark/

## License

[MIT](LICENSE) © 2026 Chulwoo Park

Licenses for the open-source software included in the app are listed in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
