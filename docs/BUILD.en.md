# Building

[한국어](BUILD.md)

## Requirements

- [Node.js](https://nodejs.org/) 20 or later
- [Rust](https://rustup.rs/) (stable)
- Windows: Visual Studio C++ Build Tools, WebView2 Runtime
- macOS: Xcode Command Line Tools

## Run in development

```sh
npm install
npm run tauri dev
```

## Release build

Windows:

```sh
npm run tauri build
```

macOS (universal for Apple Silicon and Intel):

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

Output is written under `src-tauri/target/.../release/bundle/`.
