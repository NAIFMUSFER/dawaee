import React, { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

/**
 * A QR code drawn on the device, with no network and no image service.
 *
 * The emergency code is the one thing that has to render when the phone has no
 * signal — in an ambulance, in a basement — so the symbol is encoded here
 * rather than fetched from a chart API. Byte mode with error-correction level
 * M: high enough that a crease or a thumb over one corner still scans, low
 * enough to keep the symbol coarse and readable on a cracked screen.
 *
 * The encoder follows ISO/IEC 18004 for byte-mode symbols, versions 1–40.
 * If a payload does not fit (it never should — a link is ~60 characters) the
 * component renders nothing and the caller shows the link as text instead.
 */

const ECC_CODEWORDS_PER_BLOCK_M = [
  10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
  26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
] as const;

const ECC_BLOCKS_M = [
  1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
  17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
] as const;

/** Total modules available to data before the function patterns are removed. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function eccPerBlock(version: number): number {
  return ECC_CODEWORDS_PER_BLOCK_M[version - 1] ?? 0;
}

function numBlocks(version: number): number {
  return ECC_BLOCKS_M[version - 1] ?? 0;
}

function dataCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8) - eccPerBlock(version) * numBlocks(version);
}

/** Byte mode carries UTF-8; a QR reader decodes it as such. */
function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return out;
}

function charCountBits(version: number): number {
  return version < 10 ? 8 : 16;
}

// ------------------------------- Reed–Solomon over GF(256), primitive 0x11D

function gfMultiply(a: number, b: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((b >>> i) & 1) * a;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j] ?? 0, root);
      result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0);
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() ?? 0);
    result.push(0);
    for (let i = 0; i < divisor.length; i++) {
      result[i] = (result[i] ?? 0) ^ gfMultiply(divisor[i] ?? 0, factor);
    }
  }
  return result;
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const size = version * 4 + 17;
  const result: number[] = [6];
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

export interface QrSymbol {
  size: number;
  version: number;
  /** `modules[y][x]` — true is a dark module. */
  modules: boolean[][];
}

/** Encodes `text` as a byte-mode, level-M QR symbol, or null if it does not fit. */
export function encodeQr(text: string): QrSymbol | null {
  const bytes = utf8Bytes(text);

  let version = 0;
  for (let v = 1; v <= 40; v++) {
    if (4 + charCountBits(v) + bytes.length * 8 <= dataCodewords(v) * 8) {
      version = v;
      break;
    }
  }
  if (version === 0) return null;

  const size = version * 4 + 17;

  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, charCountBits(version));
  for (const byte of bytes) push(byte, 8);

  const capacityBits = dataCodewords(version) * 8;
  push(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);

  const dataBytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] ?? 0);
    dataBytes.push(byte);
  }

  const blocks = numBlocks(version);
  const ecLength = eccPerBlock(version);
  const shortBlockLength = Math.floor(dataBytes.length / blocks);
  const shortBlockCount = blocks - (dataBytes.length % blocks);
  const divisor = rsDivisor(ecLength);

  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  for (let i = 0, offset = 0; i < blocks; i++) {
    const length = shortBlockLength + (i < shortBlockCount ? 0 : 1);
    const block = dataBytes.slice(offset, offset + length);
    offset += length;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, divisor));
  }

  // Interleaved: one codeword from each block in turn, data first, then EC.
  const codewords: number[] = [];
  for (let i = 0; i <= shortBlockLength; i++) {
    for (const block of dataBlocks) {
      const byte = block[i];
      if (byte !== undefined) codewords.push(byte);
    }
  }
  for (let i = 0; i < ecLength; i++) {
    for (const block of ecBlocks) codewords.push(block[i] ?? 0);
  }

  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  const setFunctionModule = (x: number, y: number, dark: boolean) => {
    const row = modules[y];
    const functionRow = isFunction[y];
    if (!row || !functionRow || x < 0 || x >= size) return;
    row[x] = dark;
    functionRow[x] = true;
  };

  for (let i = 0; i < size; i++) {
    setFunctionModule(6, i, i % 2 === 0);
    setFunctionModule(i, 6, i % 2 === 0);
  }

  const drawFinder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) {
          setFunctionModule(x, y, distance !== 2 && distance !== 4);
        }
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  const positions = alignmentPositions(version);
  for (let i = 0; i < positions.length; i++) {
    for (let j = 0; j < positions.length; j++) {
      const overlapsFinder =
        (i === 0 && j === 0) ||
        (i === 0 && j === positions.length - 1) ||
        (i === positions.length - 1 && j === 0);
      if (overlapsFinder) continue;
      const cx = positions[i] ?? 0;
      const cy = positions[j] ?? 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunctionModule(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  const drawFormatBits = (mask: number) => {
    // Level M is 0b00 in the format field; the BCH remainder and the 0x5412
    // mask are fixed by the standard.
    const data = (0b00 << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const formatBits = ((data << 10) | remainder) ^ 0x5412;
    const bit = (i: number) => ((formatBits >>> i) & 1) !== 0;

    for (let i = 0; i <= 5; i++) setFunctionModule(8, i, bit(i));
    setFunctionModule(8, 7, bit(6));
    setFunctionModule(8, 8, bit(7));
    setFunctionModule(7, 8, bit(8));
    for (let i = 9; i < 15; i++) setFunctionModule(14 - i, 8, bit(i));

    for (let i = 0; i < 8; i++) setFunctionModule(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) setFunctionModule(8, size - 15 + i, bit(i));
    setFunctionModule(8, size - 8, true);
  };
  drawFormatBits(0);

  if (version >= 7) {
    let remainder = version;
    for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const versionBits = (version << 12) | remainder;
    for (let i = 0; i < 18; i++) {
      const dark = ((versionBits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunctionModule(a, b, dark);
      setFunctionModule(b, a, dark);
    }
  }

  // Codewords snake up and down two-module-wide columns, skipping the
  // vertical timing column.
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        const row = modules[y];
        const functionRow = isFunction[y];
        if (!row || !functionRow || functionRow[x]) continue;
        if (bitIndex >= codewords.length * 8) continue;
        const byte = codewords[bitIndex >>> 3] ?? 0;
        row[x] = ((byte >>> (7 - (bitIndex & 7))) & 1) !== 0;
        bitIndex++;
      }
    }
  }

  const maskAt = (mask: number, x: number, y: number): boolean => {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  };

  const applyMask = (mask: number) => {
    for (let y = 0; y < size; y++) {
      const row = modules[y];
      const functionRow = isFunction[y];
      if (!row || !functionRow) continue;
      for (let x = 0; x < size; x++) {
        if (!functionRow[x] && maskAt(mask, x, y)) row[x] = !row[x];
      }
    }
  };

  const dark = (x: number, y: number): boolean => modules[y]?.[x] ?? false;

  /** The standard's four penalty rules; the lowest-scoring mask is chosen. */
  const penalty = (): number => {
    let score = 0;

    for (let y = 0; y < size; y++) {
      let run = 1;
      for (let x = 1; x < size; x++) {
        if (dark(x, y) === dark(x - 1, y)) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }
    for (let x = 0; x < size; x++) {
      let run = 1;
      for (let y = 1; y < size; y++) {
        if (dark(x, y) === dark(x, y - 1)) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }

    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const value = dark(x, y);
        if (value === dark(x + 1, y) && value === dark(x, y + 1) && value === dark(x + 1, y + 1)) score += 3;
      }
    }

    // A finder-like 1:1:3:1:1 run with a light margin confuses scanners.
    const finderLike = [true, false, true, true, true, false, true, false, false, false, false];
    const reversed = [...finderLike].reverse();
    const matches = (cells: boolean[], at: number, reference: boolean[]) =>
      reference.every((value, k) => cells[at + k] === value);
    for (let y = 0; y < size; y++) {
      const row: boolean[] = [];
      for (let x = 0; x < size; x++) row.push(dark(x, y));
      for (let x = 0; x + finderLike.length <= size; x++) {
        if (matches(row, x, finderLike) || matches(row, x, reversed)) score += 40;
      }
    }
    for (let x = 0; x < size; x++) {
      const column: boolean[] = [];
      for (let y = 0; y < size; y++) column.push(dark(x, y));
      for (let y = 0; y + finderLike.length <= size; y++) {
        if (matches(column, y, finderLike) || matches(column, y, reversed)) score += 40;
      }
    }

    let darkCount = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (dark(x, y)) darkCount++;
    const percent = (darkCount * 100) / (size * size);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;

    return score;
  };

  let bestMask = 0;
  let bestScore = Number.MAX_SAFE_INTEGER;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormatBits(mask);
    const score = penalty();
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
    }
    applyMask(mask);
  }
  applyMask(bestMask);
  drawFormatBits(bestMask);

  return { size, version, modules };
}

export interface QrCodeProps {
  value: string;
  /** Edge length in points, including the quiet zone. */
  size: number;
  accessibilityLabel: string;
  color?: string;
  background?: string;
}

/**
 * Renders the symbol as a single SVG path.
 *
 * Colours are deliberately not themed: a scanner needs dark-on-light whatever
 * the app's palette is doing, so high-contrast mode and dark surfaces must not
 * reach this.
 */
export function QrCode({ value, size, accessibilityLabel, color = '#000000', background = '#FFFFFF' }: QrCodeProps) {
  const symbol = useMemo(() => encodeQr(value), [value]);

  if (!symbol) return null;

  const quietZone = 4;
  const total = symbol.size + quietZone * 2;
  let path = '';
  for (let y = 0; y < symbol.size; y++) {
    const row = symbol.modules[y];
    if (!row) continue;
    for (let x = 0; x < symbol.size; x++) {
      if (row[x]) path += `M${x + quietZone} ${y + quietZone}h1v1h-1z`;
    }
  }

  return (
    <View accessible accessibilityRole="image" accessibilityLabel={accessibilityLabel}>
      <Svg width={size} height={size} viewBox={`0 0 ${total} ${total}`}>
        <Rect x={0} y={0} width={total} height={total} fill={background} />
        <Path d={path} fill={color} />
      </Svg>
    </View>
  );
}
