use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageReader};
use std::collections::hash_map::DefaultHasher;
use std::collections::VecDeque;
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

struct Job {
    path: PathBuf,
    replies: Vec<Reply>,
}

#[derive(Default)]
struct State {
    /// On-screen requests; the newest (last) is served first, since scrolling makes older
    /// requests stale.
    jobs: Vec<Job>,
    /// Background work: the rest of the folder, in order.
    prefetch: VecDeque<PathBuf>,
    background: usize,
    stop: bool,
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
    Job(Job),
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
            background_cap: (workers / 2).max(1),
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
        if let Some(hit) = self.inner.cached(&path) {
            return reply(Some(hit));
        }
        let dropped = {
            let mut s = self.inner.state.lock().unwrap();
            let mut job = match s.jobs.iter().position(|j| j.path == path) {
                Some(i) => s.jobs.remove(i),
                None => Job { path, replies: Vec::new() },
            };
            job.replies.push(reply);
            s.jobs.push(job);
            let excess = s.jobs.len().saturating_sub(MAX_PENDING);
            s.jobs.drain(..excess).collect::<Vec<_>>()
        };
        self.inner.ready.notify_one();
        for job in dropped {
            for reply in job.replies {
                reply(None);
            }
        }
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
    pub fn prefetch(&self, paths: Vec<PathBuf>) {
        self.inner.state.lock().unwrap().prefetch = paths.into();
        self.inner.ready.notify_all();
    }

    pub fn clear(&self) {
        let _ = fs::remove_dir_all(&self.inner.dir);
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
                    if let Some(job) = s.jobs.pop() {
                        break Task::Job(job);
                    }
                    if s.background < self.background_cap {
                        if let Some(path) = s.prefetch.pop_front() {
                            s.background += 1;
                            break Task::Prefetch(path);
                        }
                    }
                    s = self.ready.wait(s).unwrap();
                }
            };
            match task {
                Task::Job(job) => {
                    let result = self.load(&job.path);
                    let mut replies = job.replies.into_iter();
                    let last = replies.next_back();
                    for reply in replies {
                        reply(result.clone());
                    }
                    if let Some(reply) = last {
                        reply(result);
                    }
                }
                Task::Prefetch(path) => {
                    let _ = self.load(&path);
                    self.state.lock().unwrap().background -= 1;
                    self.ready.notify_one();
                }
            }
        }
    }

    fn cache_path(&self, path: &Path) -> Option<PathBuf> {
        let meta = fs::metadata(path).ok()?;
        let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis();
        let mut h = DefaultHasher::new();
        (path, meta.len(), modified, SIZE, FORMAT_VERSION).hash(&mut h);
        Some(self.dir.join(format!("{:016x}", h.finish())))
    }

    /// A thumbnail that needs no rendering: an SVG as-is, or one already in the cache.
    fn cached(&self, path: &Path) -> Option<Thumb> {
        if is_svg(path) {
            return fs::read(path).ok().map(|b| (b, "image/svg+xml"));
        }
        let base = self.cache_path(path)?;
        for (ext, mime) in [("jpg", "image/jpeg"), ("png", "image/png")] {
            if let Ok(b) = fs::read(base.with_extension(ext)) {
                return Some((b, mime));
            }
        }
        None
    }

    fn load(&self, path: &Path) -> Option<Thumb> {
        if let Some(hit) = self.cached(path) {
            return Some(hit);
        }
        let base = self.cache_path(path)?;
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
    return crate::imageio::thumbnail(path, SIZE);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        None
    }
}

fn render(path: &Path) -> Option<DynamicImage> {
    #[cfg(windows)]
    if let Some(p) = crate::wic::thumbnail(path, SIZE) {
        return image::RgbaImage::from_raw(p.width, p.height, p.rgba).map(DynamicImage::ImageRgba8);
    }
    render_with_image(path)
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
