# Changelog

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
