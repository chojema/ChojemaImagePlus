# 빌드 방법

[English](BUILD.en.md)

## 준비

- [Node.js](https://nodejs.org/) 20 이상
- [Rust](https://rustup.rs/) (stable)
- Windows: Visual Studio C++ 빌드 도구, WebView2 런타임
- macOS: Xcode Command Line Tools

## 개발 실행

```sh
npm install
npm run tauri dev
```

## 배포용 빌드

Windows:

```sh
npm run tauri build
```

macOS (Apple Silicon·Intel 공용):

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

결과물은 `src-tauri/target/.../release/bundle/` 아래에 만들어집니다.
