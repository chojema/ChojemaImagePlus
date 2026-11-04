//! Dragging image files out of the window into Finder, File Explorer or other apps.
//! The receiving app decides whether the files are copied or moved.

/// Longest side of the picture that follows the pointer, in points.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const ICON: f64 = 96.0;

#[cfg(target_os = "macos")]
mod platform {
    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSApp, NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession, NSDraggingSource, NSEvent,
        NSEventModifierFlags, NSEventType, NSImage, NSWindow,
    };
    use objc2_foundation::{NSData, NSMutableArray, NSPoint, NSRect, NSSize, NSURL};
    use std::cell::Cell;

    pub type Done = Box<dyn FnOnce(bool)>;

    pub struct Ivars {
        copy_only: bool,
        window: Retained<NSWindow>,
        done: Cell<Option<Done>>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "ChojemaImagePlusDragSource"]
        #[ivars = Ivars]
        struct Source;

        unsafe impl NSObjectProtocol for Source {}

        unsafe impl NSDraggingSource for Source {
            #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
            fn mask(&self, _session: &NSDraggingSession, context: NSDraggingContext) -> NSDragOperation {
                // Inside the app the list's own drag handles folders, so a drop here does nothing.
                if context == NSDraggingContext::WithinApplication {
                    NSDragOperation::None
                } else if self.ivars().copy_only {
                    NSDragOperation::Copy
                } else {
                    NSDragOperation::Copy | NSDragOperation::Move | NSDragOperation::Generic
                }
            }

            #[unsafe(method(draggingSession:endedAtPoint:operation:))]
            fn ended(&self, _session: &NSDraggingSession, _point: NSPoint, operation: NSDragOperation) {
                // The drag session took the button release, so the web view still believes the
                // button is held and would swallow the next press. Give it the release.
                let window = &self.ivars().window;
                if let Some(up) = mouse_event(window, NSEventType::LeftMouseUp) {
                    window.sendEvent(&up);
                }
                if let Some(done) = self.ivars().done.take() {
                    done(!operation.is_empty());
                }
            }
        }
    );

    impl Source {
        fn new(copy_only: bool, window: Retained<NSWindow>, done: Done, mtm: MainThreadMarker) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(Ivars { copy_only, window, done: Cell::new(Some(done)) });
            unsafe { msg_send![super(this), init] }
        }
    }

    /// A left-button event at the pointer's current position in `window`.
    fn mouse_event(window: &NSWindow, kind: NSEventType) -> Option<Retained<NSEvent>> {
        let mtm = MainThreadMarker::from(window);
        let timestamp = NSApp(mtm).currentEvent().map_or(0.0, |e| e.timestamp());
        NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            kind,
            window.mouseLocationOutsideOfEventStream(),
            NSEventModifierFlags::empty(),
            timestamp,
            window.windowNumber(),
            None,
            0,
            1,
            if kind == NSEventType::LeftMouseUp { 0.0 } else { 1.0 },
        )
    }

    /// Must run on the main thread while the mouse button is held.
    pub fn start(window: *mut std::ffi::c_void, paths: &[String], icon: Option<Vec<u8>>, copy_only: bool, done: Done) -> bool {
        let Some(mtm) = MainThreadMarker::new() else { return false };
        let Some(window) = (unsafe { Retained::retain(window as *mut NSWindow) }) else { return false };
        let Some(view) = window.contentView() else { return false };
        let at = window.mouseLocationOutsideOfEventStream();
        let image = icon.and_then(|bytes| NSImage::initWithData(NSImage::alloc(), &NSData::from_vec(bytes)));
        let size = image.as_ref().map_or(NSSize::new(super::ICON, super::ICON), |img| {
            let s = img.size();
            let scale = (super::ICON / s.width.max(s.height).max(1.0)).min(1.0);
            let fitted = NSSize::new(s.width * scale, s.height * scale);
            img.setSize(fitted);
            fitted
        });
        let items = NSMutableArray::<NSDraggingItem>::new();
        for (i, path) in paths.iter().enumerate() {
            let Some(url) = NSURL::from_file_path(path) else { continue };
            let item = NSDraggingItem::initWithPasteboardWriter(NSDraggingItem::alloc(), &ProtocolObject::from_retained(url));
            let offset = (i.min(3) * 6) as f64;
            let frame = NSRect::new(NSPoint::new(at.x - size.width / 2.0 + offset, at.y - size.height / 2.0 - offset), size);
            unsafe { item.setDraggingFrame_contents(frame, image.as_deref().map(|img| img as &objc2::runtime::AnyObject)) };
            items.addObject(&item);
        }
        if items.count() == 0 {
            return false;
        }
        let Some(event) = mouse_event(&window, NSEventType::LeftMouseDragged) else { return false };
        let source = Source::new(copy_only, window.clone(), done, mtm);
        view.beginDraggingSessionWithItems_event_source(&items, &event, ProtocolObject::from_ref(&*source));
        true
    }
}

#[cfg(windows)]
mod platform {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::IDataObject;
    use windows::Win32::System::Ole::{DROPEFFECT_COPY, DROPEFFECT_MOVE, DROPEFFECT_NONE};
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{
        BHID_DataObject, ILCreateFromPathW, ILFree, IShellItemArray, SHCreateShellItemArrayFromIDLists, SHDoDragDrop,
    };

    pub type Done = Box<dyn FnOnce(bool)>;

    /// Runs the system drag loop on the UI thread; returns once the files are dropped or the drag is cancelled.
    pub fn start(hwnd: isize, paths: &[String], _icon: Option<Vec<u8>>, copy_only: bool, done: Done) -> bool {
        unsafe {
            let ids: Vec<*mut ITEMIDLIST> = paths
                .iter()
                .map(|p| {
                    let wide = HSTRING::from(p.replace('/', "\\"));
                    ILCreateFromPathW(PCWSTR(wide.as_ptr()))
                })
                .filter(|id| !id.is_null())
                .collect();
            if ids.is_empty() {
                return false;
            }
            let list: Vec<*const ITEMIDLIST> = ids.iter().map(|id| *id as *const ITEMIDLIST).collect();
            let items: windows::core::Result<IShellItemArray> = SHCreateShellItemArrayFromIDLists(&list);
            for id in ids {
                ILFree(Some(id));
            }
            let Ok(data) = items.and_then(|items| items.BindToHandler::<_, IDataObject>(None, &BHID_DataObject)) else {
                return false;
            };
            // Explorer carries out a move itself, so nothing is deleted here.
            let allowed = if copy_only { DROPEFFECT_COPY } else { DROPEFFECT_COPY | DROPEFFECT_MOVE };
            let effect = SHDoDragDrop(Some(HWND(hwnd as *mut _)), &data, None, allowed);
            done(effect.is_ok_and(|e| e != DROPEFFECT_NONE));
            true
        }
    }
}

#[cfg(any(target_os = "macos", windows))]
pub use platform::{start, Done};
