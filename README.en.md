# Chojema Image+

A lightweight, fast image viewer for Windows and macOS.

[한국어](README.md)

## Features

- **List view**: choose a folder in the left-hand tree (favorites, recent folders, locations) to see its subfolders and images as thumbnails on the right. Click a subfolder to select it and double-click it or press Enter to open it, or drop photos on it to move or copy them there.
  - Fill visible thumbnails first, then prepare nearby images. Cached images load without waiting behind slow generation; obsolete queued work is discarded after scrolling or switching folders.
  - The list updates automatically when other programs add or remove files in the folder.
  - Sort by name, date modified, or size; adjust thumbnail size
  - Select several images with Ctrl (⌘) or Shift + click and browse only the selection
- **Organize and search in the list**: create a folder inside the current folder with the New folder button, the background context menu, or Ctrl/⌘ + Shift + N. The new folder is selected afterwards.
  - The name field starts with the highlighted subfolder's name, or the current folder's name when no subfolder is selected, ready to edit.
  - Select one image and press F2 or choose Rename from its context menu to change the actual filename. Subfolders can also be renamed from their context menu. Existing names are never replaced; pair files can be renamed together. Undo with Ctrl/⌘ + Z.
  - Search (Ctrl/⌘ + F) filters file and subfolder names in the current folder as you type, ignoring case. Clear with Esc or the clear button. Select all, move and copy apply only to matching images. Each pane has its own search.
  - Copy (Ctrl/⌘ + C), cut (Ctrl/⌘ + X) and paste (Ctrl/⌘ + V) image files using the system file clipboard, including files copied in Finder or File Explorer. Pasting in the app uses the existing pair-file, conflict and undo workflow. Cut files move only after a successful paste. Copying and pasting in the same folder can create a copy with a new name. On macOS, ⌘ + Option + V moves files copied in Finder.
- **Image view**: double-click a thumbnail or press Enter to view it large; press Esc to return to the list.
  - Returning restores each pane's scroll position and keeps the image you were viewing on screen.
  - Fit to window, actual size, zoom, and drag to pan
  - Hold the left mouse button on a fitted image to see that spot at twice the size; move while holding to look across the whole image, and release to return
  - Rotate by 90° (view only; the original file is not changed), full screen
  - Photo details: the right panel (below the image in a small window) shows file details, capture time, camera, lens, exposure, ISO and other main EXIF fields, plus GPS coordinates and altitude. Toggle it with the info button or I. Only information stored in the file is displayed.
- **Videos**: videos appear in the list beside images, with a thumbnail and a play mark, and start playing when opened.
  - Play/pause (Space), skip 5 seconds (Shift + → / ←), mute (M), and the player bar for seeking and volume. Moving between files, move, copy, Trash and rename work as for images.
  - Editing, export, side-by-side compare and slideshows apply to images only.
- **Side-by-side compare**: select 2 to 4 thumbnails and click Compare or press C.
  - 2 images side by side or stacked, 3 in a row, 4 in a 2×2 grid
  - Keep zoom and position in step across panes (the same area is shown even at different resolutions); rotate or close each pane
  - Separate Move (M) and Copy (C) icons for the selected pane's image. Moving or undoing updates its path and name while keeping the zoom state.
- **Move or copy to another folder**: drag selected thumbnails onto a folder, favorite, recent folder, or the path bar on the left, or use the Move/Copy button (M) to pick a folder.
  - The combined Move/Copy button (M) asks which operation to use; separate Move and Copy icons confirm the selected operation. When a file with the same name exists you choose keep both (rename), replace, or skip.
  - Pair files with the same name (RAW+JPEG, .xmp, Live Photo videos, …) can go along, and are renamed to match when the image is renamed.
  - Replaced files go to the trash, and the last operation can be undone with Ctrl (⌘) + Z.
- **Drag out of the app**: drag selected thumbnails out of the window to drop them as files in Finder or File Explorer, on the desktop, or in other apps such as mail or chat.
  - Where you drop decides between copy and move. In Finder, the same disk moves and another disk copies; hold Option (⌥) to copy or ⌘ to move. In File Explorer, the same drive moves and another drive copies; hold Ctrl to copy or Shift to move.
  - Bringing them back into the window and releasing does nothing. Files inside a package such as a photo library can only be copied.
- **Dual pane** (F6): split the list into two panes, side by side or top and bottom, to work with two folders at once.
  - Drag thumbnails from one pane to the other, or press M, to move or copy them to the other pane's folder.
  - Separate Move and Copy icons in each pane operate on the selected images and target the opposite folder.
  - Switch panes with Tab; the folder tree and favorites open in the active pane (blue underline).
- **Move to Trash**: send selected images to the Trash (Recycle Bin on Windows) with the trash button, the Delete key (⌘ + Backspace on macOS), or the right-click menu. Pair files can go along; in the image view the next image is shown afterwards.
- **Right-click menu**: view, compare side by side, move or copy to another folder, show in Finder (File Explorer), move to Trash
- **Slideshow** (S or the play button): choose the folder and whether to include subfolders, the order (list sort order / random), images smaller than the window (original size / enlarge) and larger (shrink / original size), the interval, what to show (current date and time, file name, position), looping, and full screen. Settings are remembered.
  Move the mouse or press Tab during playback to show Previous, Next, Pause/Resume, Go to image folder, Full screen, and Finish. The controls hide after inactivity and stay visible while paused or in use. Go to image folder ends the slideshow, opens the displayed image's containing folder, and selects that file.
- **Image editing** (Edit button in the image view, E, or right-click): 90° rotation, horizontal and vertical flips, crop (free, original, 1:1, 4:3, 3:2, 16:9 and portrait ratios), resize (long side / percent), and a border with chosen width and color. Save as a copy (name_edit) or replace the original (the original goes to the Trash).
- **Export to another format** (Ctrl/⌘ + E or right-click): JPEG, PNG, WebP, AVIF, HEIC (macOS), TIFF, BMP
  - Quality, size (original / long side / scale), photo information (keep / remove location only / remove all), background for transparent areas
  - Destination (subfolder of the source folder / same folder / other pane / another folder) and text added to file names
  - Photo orientation is applied to the pixels and the originals are never changed; you are asked about name conflicts.
- Favorite folders (add, remove, rename, reorder) and a recent folders list
- The Back folder button (Alt + ←, also ⌘ + [ on macOS) returns to a previously visited folder and restores selection and scroll position. It is separate from Parent folder, and each folder pane keeps its own history.
- Drag and drop, open several files at once, image file associations (open with a double-click)
- Settings: interface language (follow system / 한국어 / English), screen shown when the app opens (last folder / empty screen), delete stored thumbnails

## Supported formats

| Format | Windows | macOS |
|---|:---:|:---:|
| JPEG, PNG, GIF, WebP, BMP, ICO, AVIF, SVG | ✓ | ✓ |
| TIFF | ✓ | ✓ |
| HEIC, HEIF | ✓¹ | ✓ |
| Video: MP4, M4V, MOV, WebM | ✓² | ✓² |

¹ Requires **HEIF Image Extensions** and **HEVC Video Extensions** from the Microsoft Store. If the Windows Photos app opens HEIC files, they are already installed.

² Playback depends on the video codec. Codecs the system web view plays, such as H.264, HEVC and VP9, are supported (HEVC on Windows needs HEVC Video Extensions); files that cannot be played show a notice.

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
| New folder | Ctrl (⌘) + Shift + N |
| Rename actual file or folder | F2, context menu |
| Search names in the current list | Ctrl (⌘) + F; Esc to clear |
| Copy / cut / paste image files | Ctrl (⌘) + C / X / V |
| Move between thumbnails / extend selection | Arrow keys / Shift + arrow keys |
| View large | Enter, Space, double-click |
| Open the selected subfolder | Enter, double-click |
| Select all | Ctrl (⌘) + A |
| Compare 2–4 selected images | C |
| Move or copy selected images to another folder | M (to the other pane in dual mode), drag onto a folder |
| Dual pane on/off / switch pane | F6 / Tab |
| Undo the last move or copy | Ctrl (⌘) + Z |
| Move selected images to the Trash | Delete, ⌘ + Backspace (macOS) |
| Slideshow | S |
| Export selected images to another format | Ctrl (⌘) + E |
| Parent folder | Backspace, Alt + ↑ |
| Previously visited folder | Alt + ←, ⌘ + [ (macOS) |
| Refresh | F5 |
| Hide or show sidebar | Ctrl (⌘) + B |
| Settings | Ctrl (⌘) + , |

**Image view**

| Action | Keys |
|---|---|
| Back to list | Esc |
| Move the current image to the Trash | Delete, ⌘ + Backspace (macOS) |
| Edit the image (while editing: R / L rotate, Enter save, Esc cancel) | E |
| Toggle photo details | I |
| Next / previous image | → ↓ PageDown Space / ← ↑ PageUp Backspace |
| Video play/pause / skip 5 seconds / mute | Space / Shift + → ← / M |
| First / last image | Home / End |
| Zoom in / out | + / - , Ctrl (⌘) + wheel, trackpad pinch |
| Fit to window / actual size | 0 / 1, double-click |
| Zoom 2× while held (move to look around) | Hold the left button on the image |
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
| Focus next pane or control | Tab |
| Move / copy selected pane's image | M / C |
| Undo the last move or copy | Ctrl (⌘) + Z |
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
