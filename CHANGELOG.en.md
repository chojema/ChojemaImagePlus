# Changelog

## 0.20.0

- Hold the left mouse button on a fitted image in the single view to zoom that spot to twice the size; move while holding to look across the whole image by pointer position, and release to return

## 0.19.1

- Fix the list not updating for changes made by other apps in folders opened through a symbolic link (such as `~/Dropbox` on macOS)
- Single-click a subfolder in the list to select it; double-click or press Enter to open it

## 0.19.0

- Drag selected images out of the list into Finder, File Explorer, the desktop or other apps to copy or move them, following the drop target's default and modifier keys

## 0.18.0

- Show videos (MP4, M4V, MOV, WebM) in the list with a thumbnail and play mark, and play them in the view: play/pause (Space), skip 5 seconds (Shift + → / ←), mute (M), player bar
- Leave videos out of editing, export, compare and slideshows

## 0.17.0

- Prefill new-folder names with the highlighted subfolder's name or the current folder's name
- Fix scroll displacement when returning from the image view, including dual panes, resizing or refreshing while hidden, and leaving full screen
- Avoid rebuilding the entire folder tree after image moves, renames and undo; inspect subfolders only when expanded to avoid access prompts for unrelated protected folders

## 0.16.0

- Create a folder from the list (Ctrl/⌘ + Shift + N) and select it afterwards
- Rename actual files and folders (F2, context menu), with optional pair files, conflict protection and undo
- Search file and folder names in the current list (Ctrl/⌘ + F), independently in each pane and restored by Back
- Copy, cut and paste image files through the system file clipboard (Ctrl/⌘ + C/X/V), reusing pair-file, conflict and undo handling, including named copies in the same folder

## 0.15.0

- Photo details panel in the image view: file details, capture time, camera, lens, exposure, ISO and other main EXIF fields, plus GPS coordinates and altitude stored in the file (toggle with the info button or I)
- Slideshow controls: move the mouse or press Tab to show Previous, Next, Pause, Go to image folder, Full screen and Finish; they hide after a moment
- Back to the previous folder (Alt + ←, also ⌘ + [ on macOS): returns to a visited folder and restores selection and scroll position; each pane keeps its own history
- Separate Move and Copy icons in side-by-side compare and dual pane, and Ctrl (⌘) + Z undo in compare
- Thumbnails now load for visible cells while you scroll, and thumbnails that fail temporarily are retried automatically

## 0.14.0

- Subfolders in the thumbnail list: folder icons come before the images, and a click opens the folder (right-click: Open, show in Explorer/Finder)
- Drag photos onto a subfolder in the list to move or copy them there

## 0.13.0

- Image editing (Edit button in the viewer, E key, right-click): 90° rotation, horizontal and vertical flips, crop (free, original, 1:1, 4:3, 3:2, 16:9 and portrait ratios), resize (long side or percent), and a border with chosen width and color
- Save the edit as a copy (name_edit) or replace the original (the original goes to the trash); the saved size is shown beforehand and photo metadata is kept
- Copying, moving or deleting photos with two panes side by side no longer jumps the list to the top; scroll position and selection are kept
- Fixed empty or slow thumbnails with two panes open: unchanged cells are not redrawn when a folder changes, and both panes' thumbnails are prepared together
- Expanding cloud folders such as Dropbox in the folder tree no longer takes seconds; the arrow shows while it loads

## 0.12.1

- Fixed the thumbnail list freezing the whole app (empty boxes) after scrolling quickly to the end: visible cells are made first, and requests wait until scrolling stops
- Fixed stray text in the count badge while dragging photos

## 0.12.0

- About window: version, copyright, license, and links to the GitHub repository, Chojema App Park, and open-source licenses (macOS app menu or the ⓘ button in the sidebar)

## 0.11.0

- Interface language: choose follow system / 한국어 / English in Settings (Ctrl/⌘ + ,); applies immediately and keeps the open folders

## 0.10.0

- Large folders open instantly: virtual scrolling renders only the visible cells
- Faster thumbnails: macOS ImageIO (reduced-size decoding, embedded previews), system codecs on Windows
- Thumbnails on screen are made first; the rest are prepared in the background with spare capacity
- The list updates automatically when the folder changes, keeping selection and scroll position

## 0.9.1

- Added the bundled WebP library's license to THIRD-PARTY-NOTICES.txt

## 0.9.0

- Export to another format (Ctrl/⌘ + E, right-click): JPEG, PNG, WebP, AVIF, HEIC (macOS), TIFF, BMP
- Quality, size (original / long side / scale), photo information (keep / remove location / remove all), background for transparency
- Destination (subfolder / same folder / other pane / another folder), file name suffix, conflict prompts, progress
- Orientation applied to pixels, originals never changed, settings remembered

## 0.8.0

- Slideshow (S or the play button): choose a folder and whether to include subfolders
- Order: list sort order or random (reshuffled on every loop)
- Images smaller than the window at original size or enlarged; larger ones shrunk or at original size
- Interval, current date and time / file name / position overlays, looping, and full screen (remembered)
- Space to pause, ←/→ for previous/next, Esc to stop, with cross-fades

## 0.7.0

- Move to Trash: trash button, Delete key (⌘ + Backspace on macOS), or right-click menu, after confirmation; pair files can go along
- In the image view, trash the current image and continue with the next one
- Right-click menu: view, compare side by side, move or copy, show in Finder (File Explorer), move to Trash

## 0.6.1

- Move/copy failures now explain the reason (access denied, not enough space, file in use, …), with a button to open Privacy settings for permission problems
- Retries with a plain copy when the system copy is refused; locations that cannot be renamed into are handled by copy-then-delete (the copy is withdrawn if the original cannot be removed)
- macOS: moving replaced or undone files to the trash no longer needs extra permissions
- macOS: packages such as Photos libraries are hidden from the folder tree, and files inside them can only be copied

## 0.6.0

- Dual pane (F6): split the list into two panes, side by side or top and bottom
- Drag between panes, or press M to move or copy to the other pane's folder
- Switch the active pane with Tab; the folder tree and favorites open in the active pane
- Dual mode, its layout, and the second pane's folder are remembered

## 0.5.0

- Move or copy to another folder: drag onto the folder tree, favorites, recent folders, or path bar, or use the Move/Copy button (M)
- Choose move or copy each time; on name conflicts choose keep both (rename), replace, or skip, optionally for all remaining conflicts
- Pair files with the same name (RAW, .xmp, Live Photo, …) can go along and are renamed to match
- Replaced files go to the trash; undo the last operation (Ctrl/⌘ + Z); progress with cancel
- Moving to another drive deletes the original only after the copy has completed

## 0.4.0

- Side-by-side compare: select 2 to 4 thumbnails and click Compare or press C
- 2 images side by side or stacked, 3 in a row, 4 in a 2×2 grid
- Zoom and position kept in step across panes (the same area even at different resolutions), toggle with S
- Rotate or close each pane, full screen

## 0.3.0

- List view: folder tree on the left (favorites, recent folders, locations) and thumbnails on the right
- Thumbnail sorting (name, date modified, size), size control, and multi-selection
- Double-click or Enter to view large, Esc to return, and browse only the selected images
- Settings: screen shown when the app opens (last folder / empty screen), delete stored thumbnails
- Thumbnails are stored so folders open faster the next time

## 0.2.0

- Favorite folders: add or remove the current folder (Ctrl/⌘ + D), rename, reorder, open 1–9 directly (Ctrl/⌘ + 1–9)
- Recent folders list (Ctrl/⌘ + B), also shown on the empty screen
- HEIC and HEIF images on Windows (using the installed HEIF extensions)
- TIFF on Windows now uses the system codec and honors photo orientation
- Shortcuts now work while a non-Latin input method is active
- The window no longer freezes while a large folder is opening

## 0.1.0

First release

- Open files and folders, drag and drop, open several files at once
- Browse images in the same folder (name order with numbers in order)
- Fit to window, actual size, zoom, drag to pan
- 90° rotation, full screen
- Image file associations
- Korean and English interface
