const ko = {
  emptyText: "이미지를 끌어다 놓거나 파일·폴더를 여세요.",
  openFile: "파일 열기",
  openFolder: "폴더 열기",
  images: "이미지",
  first: "첫 번째 이미지입니다.",
  last: "마지막 이미지입니다.",
  loadFailed: "이미지를 표시할 수 없습니다.",
  unsupported: "지원하지 않는 파일 형식입니다.",
  notFound: "파일이나 폴더를 찾을 수 없습니다.",
  noImages: "표시할 이미지가 없습니다.",
  prev: "이전 (←)",
  next: "다음 (→)",
  zoomOut: "축소 (-)",
  zoomIn: "확대 (+)",
  toggleZoom: "실제 크기 / 창에 맞춤 (1 / 0)",
  fit: "창에 맞춤 (0)",
  rotateLeft: "왼쪽으로 회전 (L)",
  rotateRight: "오른쪽으로 회전 (R)",
  fullscreen: "전체 화면 (F)",
  open: "열기",
};

const en: typeof ko = {
  emptyText: "Drop an image here, or open a file or folder.",
  openFile: "Open File",
  openFolder: "Open Folder",
  images: "Images",
  first: "This is the first image.",
  last: "This is the last image.",
  loadFailed: "This image cannot be displayed.",
  unsupported: "This file type is not supported.",
  notFound: "The file or folder could not be found.",
  noImages: "There are no images to show.",
  prev: "Previous (←)",
  next: "Next (→)",
  zoomOut: "Zoom out (-)",
  zoomIn: "Zoom in (+)",
  toggleZoom: "Actual size / Fit to window (1 / 0)",
  fit: "Fit to window (0)",
  rotateLeft: "Rotate left (L)",
  rotateRight: "Rotate right (R)",
  fullscreen: "Full screen (F)",
  open: "Open",
};

export const isKorean = navigator.language.toLowerCase().startsWith("ko");
export const t = isKorean ? ko : en;

export function errorText(code: unknown): string {
  switch (code) {
    case "unsupported":
      return t.unsupported;
    case "not_found":
      return t.notFound;
    case "no_images":
      return t.noImages;
    default:
      return t.loadFailed;
  }
}
