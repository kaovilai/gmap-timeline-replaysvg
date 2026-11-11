/**
 * Minimal GIF89a encoder: median-cut palette + LZW + animation.
 * No dependencies; used by the browser page to export the globe.
 */

class ByteWriter {
  constructor() {
    this.chunks = [];
    this.current = [];
  }

  byte(value) {
    this.current.push(value & 0xff);
    if (this.current.length >= 8192) {
      this.chunks.push(Uint8Array.from(this.current));
      this.current = [];
    }
  }

  bytes(values) {
    for (const value of values) this.byte(value);
  }

  short(value) {
    this.byte(value & 0xff);
    this.byte((value >> 8) & 0xff);
  }

  string(text) {
    for (let i = 0; i < text.length; i += 1) this.byte(text.charCodeAt(i));
  }

  finish() {
    if (this.current.length) {
      this.chunks.push(Uint8Array.from(this.current));
      this.current = [];
    }
    let size = 0;
    for (const chunk of this.chunks) size += chunk.length;
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

class BitWriter {
  constructor() {
    this.out = [];
    this.acc = 0;
    this.bits = 0;
  }

  write(code, size) {
    this.acc |= code << this.bits;
    this.bits += size;
    while (this.bits >= 8) {
      this.out.push(this.acc & 0xff);
      this.acc >>= 8;
      this.bits -= 8;
    }
  }

  finish() {
    if (this.bits > 0) this.out.push(this.acc & 0xff);
    this.acc = 0;
    this.bits = 0;
    return this.out;
  }
}

function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const writer = new BitWriter();
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let table = new Map();

  writer.write(clearCode, codeSize);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i];
    const key = prefix * 4096 + k;
    const found = table.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    writer.write(prefix, codeSize);
    if (nextCode === 4096) {
      writer.write(clearCode, codeSize);
      table = new Map();
      codeSize = minCodeSize + 1;
      nextCode = endCode + 1;
    } else {
      if (nextCode >= 1 << codeSize && codeSize < 12) codeSize += 1;
      table.set(key, nextCode);
      nextCode += 1;
    }
    prefix = k;
  }
  writer.write(prefix, codeSize);
  writer.write(endCode, codeSize);
  return writer.finish();
}

function writeSubBlocks(writer, data) {
  let offset = 0;
  while (offset < data.length) {
    const size = Math.min(255, data.length - offset);
    writer.byte(size);
    for (let i = 0; i < size; i += 1) writer.byte(data[offset + i]);
    offset += size;
  }
  writer.byte(0);
}

/** Average colour per 5-bit RGB bucket, for median cut. */
function histogram(rgba) {
  const counts = new Uint32Array(32768);
  const sumR = new Float64Array(32768);
  const sumG = new Float64Array(32768);
  const sumB = new Float64Array(32768);
  const step = rgba.length > 400000 ? 4 : 1; // sample big frames
  for (let i = 0; i < rgba.length; i += 4 * step) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    counts[key] += 1;
    sumR[key] += r;
    sumG[key] += g;
    sumB[key] += b;
  }
  const buckets = [];
  for (let key = 0; key < 32768; key += 1) {
    if (!counts[key]) continue;
    buckets.push({
      count: counts[key],
      r: sumR[key] / counts[key],
      g: sumG[key] / counts[key],
      b: sumB[key] / counts[key],
    });
  }
  return buckets;
}

function boxStats(box) {
  let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
  let count = 0;
  for (const bucket of box) {
    minR = Math.min(minR, bucket.r); maxR = Math.max(maxR, bucket.r);
    minG = Math.min(minG, bucket.g); maxG = Math.max(maxG, bucket.g);
    minB = Math.min(minB, bucket.b); maxB = Math.max(maxB, bucket.b);
    count += bucket.count;
  }
  return { minR, maxR, minG, maxG, minB, maxB, count };
}

/** Median-cut palette from one RGBA frame. */
export function buildPalette(rgba, maxColors = 128) {
  const buckets = histogram(rgba);
  if (!buckets.length) return [[0, 0, 0]];
  let boxes = [buckets];
  while (boxes.length < maxColors) {
    let target = -1;
    let targetScore = 0;
    for (let i = 0; i < boxes.length; i += 1) {
      if (boxes[i].length < 2) continue;
      const stats = boxStats(boxes[i]);
      const span = Math.max(stats.maxR - stats.minR, stats.maxG - stats.minG, stats.maxB - stats.minB);
      const score = span * stats.count;
      if (score > targetScore) {
        targetScore = score;
        target = i;
      }
    }
    if (target < 0) break;
    const box = boxes[target];
    const stats = boxStats(box);
    const spans = {
      r: stats.maxR - stats.minR,
      g: stats.maxG - stats.minG,
      b: stats.maxB - stats.minB,
    };
    const channel = spans.r >= spans.g && spans.r >= spans.b ? "r" : spans.g >= spans.b ? "g" : "b";
    box.sort((a, b) => a[channel] - b[channel]);
    const half = stats.count / 2;
    let acc = 0;
    let split = 1;
    for (let i = 0; i < box.length - 1; i += 1) {
      acc += box[i].count;
      if (acc >= half) {
        split = i + 1;
        break;
      }
    }
    boxes.splice(target, 1, box.slice(0, split), box.slice(split));
  }
  return boxes.map((box) => {
    let count = 0, r = 0, g = 0, b = 0;
    for (const bucket of box) {
      count += bucket.count;
      r += bucket.r * bucket.count;
      g += bucket.g * bucket.count;
      b += bucket.b * bucket.count;
    }
    return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
  });
}

const clampByte = (value) => (value < 0 ? 0 : value > 255 ? 255 : value);

function nearestIndex(r, g, b, palette, cache) {
  const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  let index = cache.get(key);
  if (index !== undefined) return index;
  let best = 0;
  let bestDistance = Infinity;
  for (let c = 0; c < palette.length; c += 1) {
    const [pr, pg, pb] = palette[c];
    const dr = r - pr;
    const dg = g - pg;
    const db = b - pb;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = c;
    }
  }
  cache.set(key, best);
  return best;
}

/**
 * Map an RGBA frame to palette indices. With `dither`, a Floyd-Steinberg error
 * pass smooths gradients (the ocean dome); it costs compression, so it is opt-in.
 */
export function indexFrame(rgba, palette, cache = new Map(), options = {}) {
  const indices = new Uint8Array(rgba.length / 4);
  const width = options.width || 0;
  const dither = Boolean(options.dither) && width > 0 && palette.length > 1;
  if (!dither) {
    for (let i = 0, p = 0; i < rgba.length; i += 4, p += 1) {
      indices[p] = nearestIndex(rgba[i], rgba[i + 1], rgba[i + 2], palette, cache);
    }
    return indices;
  }

  const height = Math.floor(rgba.length / 4 / width);
  const error = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      const i = p * 4;
      const r = clampByte(rgba[i] + error[p * 3]);
      const g = clampByte(rgba[i + 1] + error[p * 3 + 1]);
      const b = clampByte(rgba[i + 2] + error[p * 3 + 2]);
      const index = nearestIndex(r | 0, g | 0, b | 0, palette, cache);
      indices[p] = index;
      const [pr, pg, pb] = palette[index];
      const er = r - pr;
      const eg = g - pg;
      const eb = b - pb;
      const spread = (dx, dy, weight) => {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny >= height) return;
        const q = (ny * width + nx) * 3;
        error[q] += er * weight;
        error[q + 1] += eg * weight;
        error[q + 2] += eb * weight;
      };
      spread(1, 0, 7 / 16);
      spread(-1, 1, 3 / 16);
      spread(0, 1, 5 / 16);
      spread(1, 1, 1 / 16);
    }
  }
  return indices;
}

const MIN_CODE_SIZE = (colors) => {
  let size = 1;
  while (1 << size < colors) size += 1;
  return Math.max(2, size);
};

/**
 * Streaming GIF writer: frames are appended one at a time, so a 50 fps export
 * never holds every indexed frame in memory at once.
 */
export function createGifWriter({ width, height, palette, delayMs = 80, loop = 0 }) {
  const colors = Math.max(2, palette.length);
  const minCodeSize = MIN_CODE_SIZE(colors);
  const tableSize = 1 << minCodeSize;
  const writer = new ByteWriter();

  writer.string("GIF89a");
  writer.short(width);
  writer.short(height);
  writer.byte(0xf0 | (minCodeSize - 1));
  writer.byte(0);
  writer.byte(0);
  for (let i = 0; i < tableSize; i += 1) {
    const [r, g, b] = palette[i] || [0, 0, 0];
    writer.bytes([r, g, b]);
  }
  writer.bytes([0x21, 0xff, 0x0b]);
  writer.string("NETSCAPE2.0");
  writer.bytes([0x03, 0x01, loop & 0xff, (loop >> 8) & 0xff, 0x00]);

  // GIF stores hundredths of a second; 2 cs is the floor browsers honour.
  const delay = Math.max(2, Math.round(delayMs / 10));

  return {
    addFrame(indices) {
      writer.bytes([0x21, 0xf9, 0x04, 0x04]);
      writer.short(delay);
      writer.bytes([0, 0x00]);
      writer.byte(0x2c);
      writer.short(0);
      writer.short(0);
      writer.short(width);
      writer.short(height);
      writer.byte(0);
      writer.byte(minCodeSize);
      writeSubBlocks(writer, lzwEncode(indices, minCodeSize));
    },
    finish() {
      writer.byte(0x3b);
      return writer.finish();
    },
  };
}

export function encodeGif({ width, height, frames, palette, delayMs = 80, loop = 0 }) {
  const writer = createGifWriter({ width, height, palette, delayMs, loop });
  for (const frame of frames) writer.addFrame(frame);
  return writer.finish();
}
