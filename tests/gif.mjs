/**
 * GIF encoder round-trip: encode two indexed frames, then decode the LZW data
 * back out of the produced GIF and compare. Run: node tests/gif.mjs
 */

import assert from "node:assert/strict";

import { buildPalette, encodeGif, indexFrame } from "../js/gif.js";

function makeFrame(width, height, colors) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = colors[((x >> 1) + (y >> 1)) % colors.length];
      const i = (y * width + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

function readSubBlocks(data, offset) {
  const parts = [];
  for (;;) {
    const size = data[offset];
    offset += 1;
    if (!size) break;
    parts.push(data.subarray(offset, offset + size));
    offset += size;
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return { data: out, offset };
}

function lzwDecode(data, minCodeSize, pixelCount) {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let codeSize = minCodeSize + 1;
  let dict = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i += 1) dict.push([i]);
    dict.push(null, null);
    codeSize = minCodeSize + 1;
  };
  reset();

  const out = [];
  let bitPos = 0;
  let previous = null;
  const readCode = () => {
    let code = 0;
    for (let bit = 0; bit < codeSize; bit += 1) {
      const byte = data[(bitPos >> 3) | 0] || 0;
      code |= ((byte >> (bitPos & 7)) & 1) << bit;
      bitPos += 1;
    }
    return code;
  };

  for (;;) {
    const code = readCode();
    if (code === clear) {
      reset();
      previous = null;
      continue;
    }
    if (code === end) break;
    let entry;
    if (code < dict.length && dict[code]) entry = dict[code];
    else if (code === dict.length && previous) entry = previous.concat(previous[0]);
    else throw new Error(`bad code ${code}`);
    out.push(...entry);
    if (previous) {
      dict.push(previous.concat(entry[0]));
      if (dict.length >= 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    previous = entry;
    if (out.length >= pixelCount) break;
  }
  return out.slice(0, pixelCount);
}

const width = 8;
const height = 6;
const colors = [
  [10, 20, 30],
  [200, 60, 50],
  [240, 235, 220],
  [90, 160, 210],
];
const frameA = makeFrame(width, height, colors);
const frameB = makeFrame(width, height, [...colors].reverse());

const palette = buildPalette(frameA, 16);
const indexPath = new Map();
const indicesA = indexFrame(frameA, palette, indexPath);
const indicesB = indexFrame(frameB, palette, indexPath);

const gif = encodeGif({
  width,
  height,
  frames: [indicesA, indicesB],
  palette,
  delayMs: 100,
});

assert.equal(new TextDecoder().decode(gif.subarray(0, 6)), "GIF89a");
assert.equal(gif[6] | (gif[7] << 8), width);
assert.equal(gif[8] | (gif[9] << 8), height);
const packed = gif[10];
const tableSize = 1 << ((packed & 0x07) + 1);
const extensionOffset = 13 + tableSize * 3;
assert.equal(
  new TextDecoder().decode(gif.subarray(extensionOffset + 3, extensionOffset + 14)),
  "NETSCAPE2.0",
);
assert.equal(gif[gif.length - 1], 0x3b);
let offset = extensionOffset;

// Walk to each image descriptor and decode its pixels.
const decoded = [];
while (offset < gif.length) {
  if (gif[offset] === 0x21) {
    offset += 2;
    for (;;) {
      const size = gif[offset];
      offset += 1;
      if (!size) break;
      offset += size;
    }
    continue;
  }
  if (gif[offset] === 0x2c) {
    const frameWidth = gif[offset + 5] | (gif[offset + 6] << 8);
    const frameHeight = gif[offset + 7] | (gif[offset + 8] << 8);
    const localPacked = gif[offset + 9];
    let at = offset + 10;
    if (localPacked & 0x80) {
      const localSize = 1 << ((localPacked & 0x07) + 1);
      at += localSize * 3;
    }
    const minCodeSize = gif[at];
    const block = readSubBlocks(gif, at + 1);
    decoded.push(lzwDecode(block.data, minCodeSize, frameWidth * frameHeight));
    offset = block.offset;
    continue;
  }
  break;
}

assert.equal(decoded.length, 2);
for (let i = 0; i < width * height; i += 1) {
  assert.equal(decoded[0][i], indicesA[i], `frame A pixel ${i}`);
  assert.equal(decoded[1][i], indicesB[i], `frame B pixel ${i}`);
}

console.log(`gif: ${gif.length} bytes, ${decoded.length} frames round-tripped`);
