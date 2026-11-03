# Chojema Image+

Windows와 macOS용 가볍고 빠른 이미지 뷰어입니다.

[English](README.en.md)

## 기능

- 파일이나 폴더를 열면 같은 폴더의 이미지를 이름순(숫자 인식)으로 넘겨 봅니다.
- 창에 맞춤, 실제 크기, 확대·축소, 끌어서 이동
- 90도 회전(보기 전용, 원본 파일은 바뀌지 않음)
- 전체 화면
- 끌어다 놓기, 여러 파일을 한꺼번에 열기
- 이미지 파일 연결(더블클릭으로 열기)

## 지원 형식

| 형식 | Windows | macOS |
|---|:---:|:---:|
| JPEG, PNG, GIF, WebP, BMP, ICO, AVIF, SVG | ✓ | ✓ |
| TIFF | ✓ | ✓ |
| HEIC, HEIF | | ✓ |

## 설치

[Releases](../../releases) 페이지에서 내려받습니다.

- **Windows**: `ChojemaImagePlus-<버전>-windows-x64-setup.exe`
- **macOS**: `ChojemaImagePlus-<버전>-macos-universal.dmg` (Apple Silicon, Intel)

요구 사항: Windows 10 이상(WebView2), macOS 12 이상

현재 설치 파일에는 코드 서명이 없어 처음 실행할 때 경고가 나타날 수 있습니다.

- **Windows**: SmartScreen 창에서 **추가 정보 → 실행**을 누릅니다.
- **macOS**: 앱을 처음 열 때 차단되면 **시스템 설정 → 개인정보 보호 및 보안**에서 **그래도 열기**를 누릅니다.

## 단축키

| 동작 | 키 |
|---|---|
| 다음 / 이전 이미지 | → ↓ PageDown Space / ← ↑ PageUp Backspace |
| 처음 / 마지막 이미지 | Home / End |
| 확대 / 축소 | + / - , Ctrl(⌘) + 휠, 트랙패드 핀치 |
| 창에 맞춤 / 실제 크기 | 0 / 1, 더블클릭 |
| 오른쪽 / 왼쪽 회전 | R / L |
| 전체 화면 / 나가기 | F, F11, Enter / Esc |
| 파일 열기 / 폴더 열기 | Ctrl(⌘) + O / Ctrl(⌘) + Shift + O |

마우스 휠은 이미지가 창보다 클 때 화면을 이동하고, 그렇지 않을 때 이전·다음 이미지로 넘깁니다.

## 개인정보

네트워크에 접속하지 않으며 어떤 정보도 수집하거나 전송하지 않습니다.

## 라이선스

[MIT](LICENSE) © 2026 Chulwoo Park

포함된 오픈소스 소프트웨어의 라이선스는 [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt)에 있습니다.
