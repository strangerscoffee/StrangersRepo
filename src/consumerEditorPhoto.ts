import { ApiError, invalid } from "./http";

export const MAX_PHOTO_BYTES = 1536 * 1024;
const invalidPhoto = () => invalid("Choose a valid JPEG, PNG or WebP photo.");
function dimensions(width: number, height: number) {
  if (width <= 0 || height <= 0 || width > 12000 || height > 12000 || width * height > 40000000) {
    throw invalid("Resize this photo to 40 megapixels or smaller before uploading.");
  }
}

function join(parts: Uint8Array[]) {
  const image = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    image.set(part, offset);
    offset += part.length;
  }
  return image;
}

function cleanPng(bytes: Uint8Array, view: DataView) {
  if (bytes.length < 45 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) throw invalidPhoto();
  const parts = [bytes.subarray(0, 8)];
  let data = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const end = offset + 12 + length;
    if (end > bytes.length) throw invalidPhoto();
    if (offset === 8) {
      if (name !== "IHDR" || length !== 13) throw invalidPhoto();
      dimensions(view.getUint32(offset + 8), view.getUint32(offset + 12));
    } else if (name === "IHDR") throw invalidPhoto();
    if (name === "IDAT" && length) data = true;
    if (["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "sRGB", "gAMA", "cHRM", "iCCP"].includes(name)) {
      parts.push(bytes.subarray(offset, end));
    }
    if (name === "IEND") {
      if (!data || length !== 0 || end !== bytes.length) throw invalidPhoto();
      return join(parts);
    }
    offset = end;
  }
  throw invalidPhoto();
}

// Preserve the one EXIF value needed to display a camera photo upright. Build a fresh
// little-endian TIFF directory with only orientation, excluding location and device data.
function orientationSegment(bytes: Uint8Array, start: number, end: number) {
  if (end - start < 14 || String.fromCharCode(...bytes.subarray(start, start + 6)) !== "Exif\0\0") return;
  const tiff = new DataView(bytes.buffer, bytes.byteOffset + start + 6, end - start - 6);
  const order = tiff.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) return;
  const little = order === 0x4949;
  if (tiff.getUint16(2, little) !== 42) return;
  const directory = tiff.getUint32(4, little);
  if (directory < 8 || directory + 2 > tiff.byteLength) return;
  const count = tiff.getUint16(directory, little);
  if (directory + 2 + count * 12 > tiff.byteLength) return;
  for (let i = 0; i < count; i++) {
    const field = directory + 2 + i * 12;
    if (tiff.getUint16(field, little) !== 0x112 || tiff.getUint16(field + 2, little) !== 3 || tiff.getUint32(field + 4, little) !== 1) continue;
    const value = tiff.getUint16(field + 8, little);
    if (value >= 2 && value <= 8) return new Uint8Array([
      0xff,0xe1,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,
      1,0,0x12,1,3,0,1,0,0,0,value,0,0,0,0,0,0,0,
    ]);
  }
}

function cleanJpeg(bytes: Uint8Array, view: DataView) {
  if (bytes.length < 16 || view.getUint16(0) !== 0xffd8 || view.getUint16(bytes.length - 2) !== 0xffd9) throw invalidPhoto();
  const parts = [bytes.subarray(0, 2)];
  let frame = false, scan = false, orientation = false, offset = 2;
  while (offset + 1 < bytes.length) {
    const start = offset;
    if (bytes[offset++] !== 0xff) throw invalidPhoto();
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!frame || !scan || offset !== bytes.length) throw invalidPhoto();
      parts.push(bytes.subarray(start, offset));
      return join(parts);
    }
    if (offset + 2 > bytes.length) throw invalidPhoto();
    const length = view.getUint16(offset);
    const end = offset + length;
    if (length < 2 || end > bytes.length) throw invalidPhoto();
    if ([0xc0,0xc1,0xc2].includes(marker)) {
      if (length < 8) throw invalidPhoto();
      dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
      frame = true;
    }
    // Drop comments and APP metadata, including embedded EXIF coordinates and thumbnails.
    if (marker < 0xe0 || marker === 0xee) parts.push(bytes.subarray(start, end));
    else if (marker === 0xe1 && !orientation) {
      const minimal = orientationSegment(bytes, offset + 2, end);
      if (minimal) { parts.push(minimal); orientation = true; }
    }
    offset = end;
    if (marker === 0xda) {
      if (!frame) throw invalidPhoto();
      scan = true;
      const scanStart = offset;
      while (offset + 1 < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue; }
        if (bytes[offset + 1] === 0x00 || (bytes[offset + 1] >= 0xd0 && bytes[offset + 1] <= 0xd7)) {
          offset += 2;
          continue;
        }
        break;
      }
      parts.push(bytes.subarray(scanStart, offset));
    }
  }
  throw invalidPhoto();
}

function cleanWebp(bytes: Uint8Array, view: DataView) {
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 26 || tag(0) !== "RIFF" || tag(8) !== "WEBP" || view.getUint32(4, true) + 8 !== bytes.length) throw invalidPhoto();
  const parts: Uint8Array[] = [bytes.slice(0, 12)];
  let data = false;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw invalidPhoto();
    const length = view.getUint32(offset + 4, true);
    const end = offset + 8 + length + (length % 2);
    if (end > bytes.length) throw invalidPhoto();
    const name = tag(offset), p = offset + 8;
    if (name === "ANIM" || name === "ANMF") throw invalid("Choose a still photo for the storefront.");
    if (name === "VP8 ") {
      if (data || length < 10 || bytes[p + 3] !== 0x9d || bytes[p + 4] !== 1 || bytes[p + 5] !== 0x2a) throw invalidPhoto();
      dimensions(view.getUint16(p + 6, true) & 0x3fff, view.getUint16(p + 8, true) & 0x3fff);
      data = true;
    }
    if (name === "VP8L") {
      if (data || length < 5 || bytes[p] !== 0x2f) throw invalidPhoto();
      const dims = view.getUint32(p + 1, true);
      dimensions((dims & 0x3fff) + 1, ((dims >>> 14) & 0x3fff) + 1);
      data = true;
    }
    if (name === "VP8X") {
      if (length !== 10) throw invalidPhoto();
      const width = 1 + bytes[p + 4] + (bytes[p + 5] << 8) + (bytes[p + 6] << 16);
      const height = 1 + bytes[p + 7] + (bytes[p + 8] << 8) + (bytes[p + 9] << 16);
      dimensions(width, height);
      const extended = bytes.slice(offset, end);
      extended[8] &= ~0x0c; // EXIF and XMP chunks are removed below.
      parts.push(extended);
    } else if (["VP8 ", "VP8L", "ALPH", "ICCP"].includes(name)) parts.push(bytes.subarray(offset, end));
    offset = end;
  }
  if (!data) throw invalidPhoto();
  const image = join(parts);
  new DataView(image.buffer).setUint32(4, image.length - 8, true);
  return image;
}

export function readEditorPhoto(input: Record<string, unknown>) {
  const { name, type, data } = input;
  if (typeof name !== "string" || !name.trim() || name.trim().length > 140 || /[\/\\\u0000-\u001f\u007f]/.test(name)) {
    throw invalid("Give the photo a short filename.");
  }
  if (typeof type !== "string" || !["image/jpeg", "image/png", "image/webp"].includes(type)) throw invalidPhoto();
  if (typeof data !== "string" || !data.length || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw invalidPhoto();
  if (data.length > Math.ceil(MAX_PHOTO_BYTES / 3) * 4) throw new ApiError(413, "too_large", "Photos must be 1.5 MB or smaller.");
  let binary: string;
  try { binary = atob(data); } catch { throw invalidPhoto(); }
  if (binary.length > MAX_PHOTO_BYTES) throw new ApiError(413, "too_large", "Photos must be 1.5 MB or smaller.");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const cleaned = type === "image/png" ? cleanPng(bytes, view) : type === "image/jpeg" ? cleanJpeg(bytes, view) : cleanWebp(bytes, view);
  return {name: name.trim(), type, data: cleaned};
}
