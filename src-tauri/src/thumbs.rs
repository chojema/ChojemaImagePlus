use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageReader};
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::UNIX_EPOCH;

/// Longest side of a stored thumbnail, in pixels.
pub const SIZE: u32 = 320;
const FORMAT_VERSION: u32 = 1;
const CACHE_LIMIT: u64 = 1024 * 1024 * 1024;
const CACHE_TARGET: u64 = 768 * 1024 * 1024;
/// Pending on-screen requests kept at most; older ones are answered empty (their cells are
/// long gone after fast scrolling) so the queue cannot grow without bound.
const MAX_PENDING: usize = 2000;

pub type Thumb = (Vec<u8>, &'static str);
pub type Reply = Box<dyn FnOnce(Option<Thumb>) + Send>;

#[derive(Clone, Copy)]
pub struct Context {
    pub owner: u64,
    pub revision: u64,
}

struct Observer {
    context: Option<Context>,
    reply: Reply,
}

struct Viewport {
    revision: u64,
    paths: HashMap<PathBuf, usize>,
    visible: usize,
}

struct Job {
    path: PathBuf,
    replies: Vec<Observer>,
}

#[derive(Default)]
struct State {
    /// Visible rows first, with FIFO order for equal priorities across panes.
    jobs: Vec<Job>,
    /// Includes background renders so a visible request can join work already in progress.
    running: HashMap<PathBuf, Vec<Observer>>,
    views: HashMap<u64, Viewport>,
    /// Background work: the rest of the folder, in order.
    prefetch: VecDeque<PathBuf>,
    background: usize,
    stop: bool,
}

impl State {
    fn wanted(&self, path: &Path, context: Option<Context>) -> bool {
        context.is_none_or(|context| {
            self.views.get(&context.owner).is_some_and(|view| {
                context.revision <= view.revision && view.paths.contains_key(path)
            })
        })
    }

    fn priority(&self, job: &Job) -> (u8, usize) {
        job.replies.iter().filter_map(|observer| match observer.context {
            None => Some((0, 0)),
            Some(context) => self.views.get(&context.owner).and_then(|view| {
                view.paths.get(&job.path).map(|&rank| (u8::from(rank >= view.visible), rank))
            }),
        }).min().unwrap_or((1, usize::MAX))
    }

    fn take_job(&mut self, background_room: bool) -> Option<(Job, bool)> {
        let (index, priority) = self.jobs.iter().enumerate()
            .map(|(index, job)| (index, self.priority(job)))
            .filter(|(_, priority)| priority.0 == 0 || background_room)
            .min_by_key(|(_, priority)| *priority)?;
        Some((self.jobs.remove(index), priority.0 != 0))
    }
}

struct Inner {
    dir: PathBuf,
    state: Mutex<State>,
    ready: Condvar,
    /// Workers allowed on background work at once, so on-screen requests always find one free.
    background_cap: usize,
}

/// Thumbnails rendered on demand and cached on disk, keyed by path, size and modification time.
/// A fixed pool of worker threads does the rendering, so waiting requests never hold threads
/// that other work needs.
pub struct Thumbs {
    inner: Arc<Inner>,
}

enum Task {
    Job(PathBuf, bool),
    Prefetch(PathBuf),
}

impl Thumbs {
    pub fn new(dir: PathBuf) -> Self {
        let cores = std::thread::available_parallelism().map_or(4, |n| n.get());
        let workers = cores.saturating_sub(1).clamp(2, 8);
        let inner = Arc::new(Inner {
            dir,
            state: Mutex::new(State::default()),
            ready: Condvar::new(),
            background_cap: (workers / 4).max(1),
        });
        for n in 0..workers {
            let inner = inner.clone();
            let _ = std::thread::Builder::new().name(format!("thumbs-{n}")).spawn(move || inner.work());
        }
        Thumbs { inner }
    }

    /// Answers from the cache right away when possible; otherwise queues the request and
    /// returns, and `reply` runs on a worker once the thumbnail is ready.
    pub fn request(&self, path: PathBuf, reply: Reply) {
        self.request_in_view(path, None, reply);
    }

    pub fn request_in_view(&self, path: PathBuf, context: Option<Context>, reply: Reply) {
        if !self.inner.state.lock().unwrap().wanted(&path, context) {
            return reply(None);
        }
        if let Some(hit) = self.inner.cached(&path) {
            return reply(Some(hit));
        }
        let dropped = {
            let mut s = self.inner.state.lock().unwrap();
            if !s.wanted(&path, context) {
                drop(s);
                return reply(None);
            }
            let observer = Observer { context, reply };
            if let Some(replies) = s.running.get_mut(&path) {
                replies.push(observer);
                return;
            }
            let mut job = match s.jobs.iter().position(|j| j.path == path) {
                Some(i) => s.jobs.remove(i),
                None => Job { path, replies: Vec::new() },
            };
            job.replies.push(observer);
            s.jobs.push(job);
            let excess = s.jobs.len().saturating_sub(MAX_PENDING);
            s.jobs.drain(..excess).collect::<Vec<_>>()
        };
        self.inner.ready.notify_one();
        for job in dropped {
            for observer in job.replies {
                (observer.reply)(None);
            }
        }
    }

    /// Replace one pane's wanted cells without interrupting work another pane still uses.
    /// Retain an empty revision as a tombstone so delayed older updates cannot revive it.
    pub fn viewport(&self, owner: u64, revision: u64, paths: Vec<PathBuf>, visible: usize) {
        let mut dropped = Vec::new();
        {
            let mut s = self.inner.state.lock().unwrap();
            if s.views.get(&owner).is_some_and(|view| revision <= view.revision) { return; }
            let paths = paths.into_iter().take(MAX_PENDING).enumerate().map(|(rank, path)| (path, rank)).collect();
            s.views.insert(owner, Viewport { revision, paths, visible });
            let State { jobs, running, views, .. } = &mut *s;
            let retain = |path: &Path, observers: &mut Vec<Observer>, dropped: &mut Vec<Reply>| {
                let mut kept = Vec::with_capacity(observers.len());
                for observer in observers.drain(..) {
                    let wanted = observer.context.is_none_or(|context| {
                        views.get(&context.owner).is_some_and(|view| {
                            context.revision <= view.revision && view.paths.contains_key(path)
                        })
                    });
                    if wanted { kept.push(observer); } else { dropped.push(observer.reply); }
                }
                *observers = kept;
            };
            for job in jobs.iter_mut() { retain(&job.path, &mut job.replies, &mut dropped); }
            jobs.retain(|job| !job.replies.is_empty());
            // Running decoders complete into the cache, even if every observer disappeared.
            for (path, observers) in running.iter_mut() { retain(path, observers, &mut dropped); }
        }
        for reply in dropped { reply(None); }
        self.inner.ready.notify_all();
    }

    /// Waits for one thumbnail.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn get(&self, path: &Path) -> Option<Thumb> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.request(path.to_path_buf(), Box::new(move |r| drop(tx.send(r))));
        rx.recv().ok().flatten()
    }

    /// Renders missing thumbnails for `paths` in the background, in order, with spare
    /// capacity. A newer call replaces the remaining work of an older one.
    #[cfg(test)]
    pub fn prefetch(&self, paths: Vec<PathBuf>) {
        self.inner.state.lock().unwrap().prefetch = paths.into();
        self.inner.ready.notify_all();
    }

    pub fn clear(&self) {
        let _ = fs::remove_dir_all(&self.inner.dir);
    }

    /// A browser decode failure may be a damaged cache entry. A retry must render it afresh.
    pub fn invalidate(&self, path: &Path) {
        if let Some(base) = self.inner.cache_path(path) {
            for ext in ["jpg", "png"] {
                let _ = fs::remove_file(base.with_extension(ext));
            }
        }
    }

    /// Deletes the oldest cached files once the cache grows past its limit.
    pub fn trim(&self) {
        let dir = &self.inner.dir;
        let Ok(read) = fs::read_dir(dir) else { return };
        let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = read
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let meta = e.metadata().ok()?;
                Some((meta.modified().ok()?, meta.len(), e.path()))
            })
            .collect();
        let mut total: u64 = files.iter().map(|f| f.1).sum();
        if total <= CACHE_LIMIT {
            return;
        }
        files.sort_by_key(|f| f.0);
        for (_, len, path) in files {
            if total <= CACHE_TARGET {
                break;
            }
            if fs::remove_file(&path).is_ok() {
                total -= len;
            }
        }
    }
}

impl Drop for Thumbs {
    fn drop(&mut self) {
        self.inner.state.lock().unwrap().stop = true;
        self.inner.ready.notify_all();
    }
}

impl Inner {
    fn work(&self) {
        loop {
            let task = {
                let mut s = self.state.lock().unwrap();
                loop {
                    if s.stop {
                        return;
                    }
                    let background_room = s.background < self.background_cap;
                    if let Some((job, background)) = s.take_job(background_room) {
                        if background { s.background += 1; }
                        s.running.insert(job.path.clone(), job.replies);
                        break Task::Job(job.path, background);
                    }
                    if s.background < self.background_cap {
                        if let Some(path) = s.prefetch.pop_front() {
                            if s.running.contains_key(&path) {
                                continue;
                            }
                            s.running.insert(path.clone(), Vec::new());
                            s.background += 1;
                            break Task::Prefetch(path);
                        }
                    }
                    s = self.ready.wait(s).unwrap();
                }
            };
            match task {
                Task::Job(path, background) => {
                    let result = self.load(&path);
                    self.finish(&path, result);
                    if background {
                        self.state.lock().unwrap().background -= 1;
                        self.ready.notify_all();
                    }
                }
                Task::Prefetch(path) => {
                    // A warm folder needs only existence checks. Do not read every cached image
                    // again unless an on-screen request joined this background task.
                    if self.is_cached(&path) {
                        let mut s = self.state.lock().unwrap();
                        if s.running.get(&path).is_some_and(Vec::is_empty) {
                            s.running.remove(&path);
                            s.background -= 1;
                            drop(s);
                            self.ready.notify_one();
                            continue;
                        }
                    }
                    let result = self.load(&path);
                    self.finish(&path, result);
                    self.state.lock().unwrap().background -= 1;
                    self.ready.notify_one();
                }
            }
        }
    }

    fn finish(&self, path: &Path, result: Option<Thumb>) {
        let mut replies = self.state.lock().unwrap().running.remove(path).unwrap_or_default().into_iter();
        let last = replies.next_back();
        for observer in replies {
            (observer.reply)(result.clone());
        }
        if let Some(observer) = last {
            (observer.reply)(result);
        }
    }

    fn cache_path(&self, path: &Path) -> Option<PathBuf> {
        let meta = fs::metadata(path).ok()?;
        let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis();
        let mut h = DefaultHasher::new();
        (path, meta.len(), modified, SIZE, FORMAT_VERSION).hash(&mut h);
        Some(self.dir.join(format!("{:016x}", h.finish())))
    }

    fn is_cached(&self, path: &Path) -> bool {
        is_svg(path)
            || self
                .cache_path(path)
                .is_some_and(|base| ["jpg", "png"].iter().any(|ext| base.with_extension(ext).is_file()))
    }

    /// A thumbnail that needs no rendering: an SVG as-is, or one already in the cache.
    fn cached(&self, path: &Path) -> Option<Thumb> {
        if is_svg(path) {
            return fs::read(path).ok().map(|b| (b, "image/svg+xml"));
        }
        let base = self.cache_path(path)?;
        self.cached_at(&base)
    }

    fn cached_at(&self, base: &Path) -> Option<Thumb> {
        for (ext, mime) in [("jpg", "image/jpeg"), ("png", "image/png")] {
            if let Ok(b) = fs::read(base.with_extension(ext)) {
                return Some((b, mime));
            }
        }
        None
    }

    fn load(&self, path: &Path) -> Option<Thumb> {
        if is_svg(path) { return self.cached(path); }
        let base = self.cache_path(path)?;
        if let Some(hit) = self.cached_at(&base) {
            return Some(hit);
        }
        let (bytes, ext, mime) = fast(path).or_else(|| render(path).and_then(encode))?;
        let _ = fs::create_dir_all(&self.dir);
        let target = base.with_extension(ext);
        let tmp = base.with_extension(format!("{ext}.tmp"));
        if fs::write(&tmp, &bytes).is_ok() {
            let _ = fs::rename(&tmp, &target);
        }
        Some((bytes, mime))
    }
}

fn is_svg(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("svg"))
}

/// The platform's thumbnail engine, which avoids decoding the full image.
fn fast(path: &Path) -> Option<(Vec<u8>, &'static str, &'static str)> {
    #[cfg(target_os = "macos")]
    return if crate::files::is_video(path) {
        crate::imageio::video_thumbnail(path, SIZE)
    } else {
        crate::imageio::thumbnail(path, SIZE)
    };
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        None
    }
}

fn render(path: &Path) -> Option<DynamicImage> {
    if crate::files::is_video(path) {
        return video_frame(path);
    }
    #[cfg(windows)]
    if let Some(p) = crate::wic::thumbnail(path, SIZE) {
        return image::RgbaImage::from_raw(p.width, p.height, p.rgba).map(DynamicImage::ImageRgba8);
    }
    render_with_image(path)
}

/// The system's thumbnail for a video, which uses the codecs installed on the system.
fn video_frame(path: &Path) -> Option<DynamicImage> {
    #[cfg(windows)]
    return crate::wic::shell_thumbnail(path, SIZE)
        .and_then(|p| image::RgbaImage::from_raw(p.width, p.height, p.rgba))
        .map(DynamicImage::ImageRgba8);
    #[cfg(not(windows))]
    {
        let _ = path;
        None
    }
}

fn render_with_image(path: &Path) -> Option<DynamicImage> {
    let mut decoder = ImageReader::open(path)
        .ok()?
        .with_guessed_format()
        .ok()?
        .into_decoder()
        .ok()?;
    let orientation = decoder.orientation().ok();
    let mut img = DynamicImage::from_decoder(decoder).ok()?;
    if let Some(o) = orientation {
        img.apply_orientation(o);
    }
    Some(if img.width() > SIZE || img.height() > SIZE {
        img.thumbnail(SIZE, SIZE)
    } else {
        img
    })
}

fn encode(img: DynamicImage) -> Option<(Vec<u8>, &'static str, &'static str)> {
    let mut out = Vec::new();
    let has_alpha = img.color().has_alpha() && img.to_rgba8().pixels().any(|p| p.0[3] < 255);
    if has_alpha {
        let rgba = img.to_rgba8();
        PngEncoder::new(&mut out)
            .write_image(&rgba, rgba.width(), rgba.height(), image::ExtendedColorType::Rgba8)
            .ok()?;
        Some((out, "png", "image/png"))
    } else {
        let rgb = img.to_rgb8();
        JpegEncoder::new_with_quality(&mut out, 82)
            .write_image(&rgb, rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
            .ok()?;
        Some((out, "jpg", "image/jpeg"))
    }
}

#[cfg(test)]
mod tests {
    use super::Thumbs;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    fn idle(base: &std::path::Path) -> Thumbs {
        Thumbs { inner: std::sync::Arc::new(super::Inner {
            dir: base.join("cache"),
            state: std::sync::Mutex::new(super::State::default()),
            ready: std::sync::Condvar::new(),
            background_cap: 1,
        }) }
    }

    #[test]
    fn cached_images_bypass_busy_decoders() {
        let base = scratch("cache-lane");
        let files = pngs(&base, 2, 20, 10);
        let thumbs = idle(&base);
        let cached = thumbs.inner.load(&files[1]).unwrap();
        thumbs.inner.state.lock().unwrap().running.insert(files[0].clone(), Vec::new());
        let (tx, rx) = std::sync::mpsc::channel();
        thumbs.request(files[1].clone(), Box::new(move |result| { let _ = tx.send(result); }));
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), Some(cached));
        assert!(thumbs.inner.state.lock().unwrap().jobs.is_empty());
        drop(thumbs);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn viewport_cancellation_preserves_other_panes_and_rejects_old_updates() {
        let base = scratch("view-cancel");
        let path = base.join("shared.png");
        let thumbs = idle(&base);
        let (tx, rx) = std::sync::mpsc::channel();
        for owner in [1, 2] {
            thumbs.viewport(owner, 1, vec![path.clone()], 1);
            let tx = tx.clone();
            thumbs.request_in_view(path.clone(), Some(super::Context { owner, revision: 1 }),
                Box::new(move |result| { let _ = tx.send((owner, result.is_some())); }));
        }
        assert_eq!(thumbs.inner.state.lock().unwrap().jobs[0].replies.len(), 2);
        thumbs.viewport(1, 3, Vec::new(), 0);
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), (1, false));
        thumbs.viewport(1, 2, vec![path.clone()], 1);
        {
            let s = thumbs.inner.state.lock().unwrap();
            assert_eq!(s.jobs.len(), 1);
            assert_eq!(s.jobs[0].replies.len(), 1);
            assert!(!s.wanted(&path, Some(super::Context { owner: 1, revision: 1 })));
        }
        thumbs.viewport(2, 2, Vec::new(), 0);
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), (2, false));
        assert!(thumbs.inner.state.lock().unwrap().jobs.is_empty());
        drop(thumbs);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn scrolling_reprioritizes_pending_rows_and_reserves_visible_capacity() {
        let base = scratch("view-priority");
        let a = base.join("a.png");
        let b = base.join("b.png");
        let margin = base.join("margin.png");
        let thumbs = idle(&base);
        thumbs.viewport(1, 1, vec![a.clone(), b.clone(), margin.clone()], 2);
        for path in [&margin, &b, &a] {
            thumbs.request_in_view(path.clone(), Some(super::Context { owner: 1, revision: 1 }), Box::new(|_| {}));
        }
        // An overlapping row stays attached to its existing request while its priority changes.
        thumbs.viewport(1, 2, vec![b.clone(), a.clone(), margin.clone()], 2);
        let mut s = thumbs.inner.state.lock().unwrap();
        assert_eq!(s.take_job(false).unwrap().0.path, b);
        assert_eq!(s.take_job(false).unwrap().0.path, a);
        assert!(s.take_job(false).is_none());
        let (job, background) = s.take_job(true).unwrap();
        assert_eq!(job.path, margin);
        assert!(background);
        drop(s);
        drop(thumbs);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn cancelled_running_work_is_reused_by_a_new_view() {
        let base = scratch("view-running");
        let path = base.join("shared.png");
        let thumbs = idle(&base);
        thumbs.viewport(1, 1, vec![path.clone()], 1);
        let (tx, rx) = std::sync::mpsc::channel();
        let first = tx.clone();
        thumbs.request_in_view(path.clone(), Some(super::Context { owner: 1, revision: 1 }),
            Box::new(move |result| { let _ = first.send((1, result.is_some())); }));
        {
            let mut s = thumbs.inner.state.lock().unwrap();
            let job = s.take_job(true).unwrap().0;
            s.running.insert(path.clone(), job.replies);
        }
        thumbs.viewport(1, 2, Vec::new(), 0);
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), (1, false));
        assert!(thumbs.inner.state.lock().unwrap().running.contains_key(&path));
        thumbs.viewport(2, 1, vec![path.clone()], 1);
        thumbs.request_in_view(path.clone(), Some(super::Context { owner: 2, revision: 1 }),
            Box::new(move |result| { let _ = tx.send((2, result.is_some())); }));
        assert!(thumbs.inner.state.lock().unwrap().jobs.is_empty());
        thumbs.inner.finish(&path, Some((vec![1], "image/jpeg")));
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), (2, true));
        drop(thumbs);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn visible_requests_join_a_running_background_render() {
        let base = scratch("join-running");
        let path = base.join("in-progress.png");
        // No workers: keep a background render in progress until the test completes it.
        let thumbs = Thumbs {
            inner: std::sync::Arc::new(super::Inner {
                dir: base.join("cache"),
                state: std::sync::Mutex::new(super::State::default()),
                ready: std::sync::Condvar::new(),
                background_cap: 1,
            }),
        };
        thumbs.inner.state.lock().unwrap().running.insert(path.clone(), Vec::new());
        let (tx, rx) = std::sync::mpsc::channel();
        for _ in 0..2 {
            let tx = tx.clone();
            thumbs.request(path.clone(), Box::new(move |result| { let _ = tx.send(result); }));
        }
        {
            let state = thumbs.inner.state.lock().unwrap();
            assert!(state.jobs.is_empty(), "must not render the same file again");
            assert_eq!(state.running[&path].len(), 2);
        }
        thumbs.inner.finish(&path, Some((vec![1, 2, 3], "image/jpeg")));
        for _ in 0..2 {
            assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), Some((vec![1, 2, 3], "image/jpeg")));
        }
        assert!(thumbs.inner.state.lock().unwrap().running.is_empty());
        drop(thumbs);
        let _ = std::fs::remove_dir_all(base);
    }

    fn scratch(name: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("image-plus-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    fn pngs(base: &std::path::Path, n: u8, w: u32, h: u32) -> Vec<PathBuf> {
        (0..n)
            .map(|i| {
                let p = base.join(format!("{i}.png"));
                image::RgbImage::from_pixel(w, h, image::Rgb([i.wrapping_mul(40), 0, 0])).save(&p).unwrap();
                p
            })
            .collect()
    }

    /// Timing helper: `THUMB_BENCH=/folder cargo test --release bench -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench() {
        let dir = std::env::var("THUMB_BENCH").expect("THUMB_BENCH");
        let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).collect();
        files.sort();
        let start = std::time::Instant::now();
        let engine = std::env::var("THUMB_ENGINE").unwrap_or_default();
        for f in &files {
            if engine == "image" {
                assert!(super::render(f).and_then(super::encode).is_some());
            } else {
                assert!(super::fast(f).or_else(|| super::render(f).and_then(super::encode)).is_some());
            }
        }
        let ms = start.elapsed().as_millis();
        println!("{} files, {} ms total, {} ms each", files.len(), ms, ms / files.len().max(1) as u128);
    }

    #[test]
    fn prefetch_fills_the_cache() {
        let base = scratch("prefetch");
        let files = pngs(&base, 5, 50, 40);
        let thumbs = Thumbs::new(base.join("cache"));
        thumbs.prefetch(files.clone());
        let deadline = Instant::now() + Duration::from_secs(10);
        while std::fs::read_dir(base.join("cache")).map_or(0, |d| d.count()) < 5 {
            assert!(Instant::now() < deadline, "prefetch did not finish");
            std::thread::sleep(Duration::from_millis(20));
        }
        // Already cached: answered right away with the same bytes.
        let (a, _) = thumbs.get(&files[0]).unwrap();
        let (b, _) = thumbs.get(&files[0]).unwrap();
        assert_eq!(a, b);
        drop(thumbs);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn renders_and_caches_scaled_thumbnail() {
        let base = scratch("thumbs");
        let src = base.join("big.png");
        image::RgbImage::from_pixel(1000, 500, image::Rgb([200, 10, 10])).save(&src).unwrap();

        let thumbs = Thumbs::new(base.join("cache"));
        let (bytes, mime) = thumbs.get(&src).expect("thumbnail");
        assert_eq!(mime, "image/jpeg");
        let img = image::load_from_memory(&bytes).unwrap();
        assert_eq!((img.width(), img.height()), (super::SIZE, super::SIZE / 2));
        assert_eq!(std::fs::read_dir(base.join("cache")).unwrap().count(), 1);
        let (again, _) = thumbs.get(&src).unwrap();
        assert_eq!(again, bytes);
        drop(thumbs);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn retry_replaces_a_damaged_cached_thumbnail() {
        let base = scratch("damaged-cache");
        let files = pngs(&base, 1, 80, 60);
        let thumbs = Thumbs::new(base.join("cache"));
        thumbs.get(&files[0]).expect("first render");
        let cache = std::fs::read_dir(base.join("cache")).unwrap().next().unwrap().unwrap().path();
        std::fs::write(cache, b"incomplete thumbnail").unwrap();
        thumbs.invalidate(&files[0]);
        let (bytes, _) = thumbs.get(&files[0]).expect("regenerated thumbnail");
        let image = image::load_from_memory(&bytes).expect("valid thumbnail after retry");
        assert_eq!((image.width(), image.height()), (80, 60));
        assert!(files[0].is_file());
        drop(thumbs);
        let _ = std::fs::remove_dir_all(base);
    }

    /// Thousands of requests at once (fast scrolling) must not block the caller, every request
    /// gets an answer, and duplicates of one file are rendered once.
    #[test]
    fn many_requests_return_at_once_and_all_get_answers() {
        let base = scratch("burst");
        let files = pngs(&base, 40, 900, 600);
        let thumbs = Thumbs::new(base.join("cache"));
        let (tx, rx) = std::sync::mpsc::channel();
        let start = Instant::now();
        let total = 3000;
        for k in 0..total {
            let tx = tx.clone();
            thumbs.request(files[k % files.len()].clone(), Box::new(move |r| { let _ = tx.send(r.is_some()); }));
        }
        assert!(start.elapsed() < Duration::from_secs(2), "request() blocked: {:?}", start.elapsed());
        drop(tx);
        let answers: Vec<bool> = rx.iter().take(total).collect();
        assert_eq!(answers.len(), total);
        assert!(answers.iter().all(|ok| *ok));
        assert_eq!(std::fs::read_dir(base.join("cache")).unwrap().count(), files.len());
        drop(thumbs);
        let _ = std::fs::remove_dir_all(base);
    }

    /// Past the pending limit the oldest requests are answered empty instead of piling up.
    #[test]
    fn oldest_requests_are_dropped_past_the_limit() {
        let base = scratch("limit");
        let files = pngs(&base, 1, 10, 10);
        let thumbs = Thumbs::new(base.join("cache"));
        // Fill the queue directly, without waking the workers.
        let mut s = thumbs.inner.state.lock().unwrap();
        for k in 0..(super::MAX_PENDING + 5) {
            s.jobs.push(super::Job { path: base.join(format!("missing-{k}.png")), replies: Vec::new() });
        }
        drop(s);
        let (tx, rx) = std::sync::mpsc::channel();
        thumbs.request(files[0].with_file_name("new.png"), Box::new(move |r| { let _ = tx.send(r.is_some()); }));
        assert!(thumbs.inner.state.lock().unwrap().jobs.len() <= super::MAX_PENDING);
        assert_eq!(rx.recv_timeout(Duration::from_secs(10)), Ok(false));
        drop(thumbs);
        let _ = std::fs::remove_dir_all(base);
    }
}
