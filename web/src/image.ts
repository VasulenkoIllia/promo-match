// The reference photo before the search: cropped to the frame drawn over it and shrunk to the size of the catalogue's
// photos (Axpol 1000×1000, Midocean 700×700, src/embeddings/image.ts), then sent as a JPEG. The photo stays in the
// browser's memory until then; the server keeps it in memory only.

export interface Point {
  x: number;
  y: number;
}

// In the photo's own pixels
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Size {
  width: number;
  height: number;
}

const MAX_OUTPUT_SIDE_PX = 1024;
// A frame narrower than this on screen is a click, not a crop: the whole photo goes
export const MIN_CROP_SIDE_PX = 16;
const JPEG_QUALITY = 0.9;
const JPEG_DATA_URL = "data:image/jpeg;base64,";
// A transparent PNG goes on white, like the catalogue's photos
const BACKGROUND = "#ffffff";

export function fullRect(size: Size): Rect {
  return { x: 0, y: 0, width: size.width, height: size.height };
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max);
}

// The frame between two points of a drag in any direction, within the photo; null when either side is under minSidePx
// (the photo's pixels per MIN_CROP_SIDE_PX on screen), or not a number at all
export function cropRect(from: Point, to: Point, size: Size, minSidePx: number): Rect | null {
  const [fromX, toX] = [clamp(from.x, size.width), clamp(to.x, size.width)];
  const [fromY, toY] = [clamp(from.y, size.height), clamp(to.y, size.height)];
  const x = Math.round(Math.min(fromX, toX));
  const y = Math.round(Math.min(fromY, toY));
  const width = Math.round(Math.max(fromX, toX)) - x;
  const height = Math.round(Math.max(fromY, toY)) - y;
  return width >= minSidePx && height >= minSidePx ? { x, y, width, height } : null;
}

// The size the frame is sent at: its longest side at most MAX_OUTPUT_SIDE_PX, never enlarged
export function outputSize(rect: Rect): Size {
  const scale = Math.min(1, MAX_OUTPUT_SIDE_PX / Math.max(rect.width, rect.height));
  return { width: Math.max(1, Math.round(rect.width * scale)), height: Math.max(1, Math.round(rect.height * scale)) };
}

// A data URL of the frame as a JPEG, as the API takes it
export function encodeJpeg(image: CanvasImageSource, rect: Rect): string {
  if (!(rect.width > 0 && rect.height > 0)) throw new Error(`the frame is ${rect.width}×${rect.height}`);
  const size = outputSize(rect);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("the browser has no 2d canvas");
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, size.width, size.height);
  context.imageSmoothingQuality = "high";
  context.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, size.width, size.height);
  // A canvas the browser cannot encode gives "data:,"
  const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  if (!dataUrl.startsWith(JPEG_DATA_URL)) throw new Error("the browser did not encode the photo as a JPEG");
  return dataUrl;
}
