/**
 * QR encoder for the host join link (Plan A2/B2). The host screen shows a QR a phone can actually
 * scan, so this is a real byte-mode encoder — not a decorative square. Error correction level L is
 * enough for a screen-read code a metre away, and versions 1..10 cover every LAN URL plus a room
 * code with room to spare.
 *
 * Validation lives in the test: block syndromes must be zero, finder/timing/format structure must
 * be present, capacity overflow must throw rather than truncate.
 *
 * Reference: ISO/IEC 18004. Reed-Solomon over GF(256) with primitive polynomial 0x11d.
 */

export type QrMatrix = readonly (readonly boolean[])[];

/** Data capacity in bytes (byte mode) and error-correction shape per version, level L. */
interface VersionSpec {
  readonly ecCodewordsPerBlock: number;
  /** Data codewords per block, largest block last (shorter blocks come first in the standard). */
  readonly dataBlocks: readonly number[];
  readonly alignment: readonly number[];
}

const VERSIONS: readonly VersionSpec[] = [
  { ecCodewordsPerBlock: 7, dataBlocks: [19], alignment: [] },
  { ecCodewordsPerBlock: 10, dataBlocks: [34], alignment: [6, 18] },
  { ecCodewordsPerBlock: 15, dataBlocks: [55], alignment: [6, 22] },
  { ecCodewordsPerBlock: 20, dataBlocks: [80], alignment: [6, 26] },
  { ecCodewordsPerBlock: 26, dataBlocks: [108], alignment: [6, 30] },
  { ecCodewordsPerBlock: 18, dataBlocks: [68, 68], alignment: [6, 34] },
  { ecCodewordsPerBlock: 20, dataBlocks: [78, 78], alignment: [6, 22, 38] },
  { ecCodewordsPerBlock: 24, dataBlocks: [97, 97], alignment: [6, 24, 42] },
  { ecCodewordsPerBlock: 30, dataBlocks: [116, 116], alignment: [6, 26, 46] },
];

const ECC_L_FORMAT_BITS = 1; // level L indicator (01) is the value 1 in the 2-bit field.

// GF(256) tables, built once.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let value = 1;
  for (let index = 0; index < 255; index++) {
    EXP[index] = value;
    LOG[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index++) EXP[index] = EXP[index - 255]!;
}

function gfMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** Generator polynomial for `degree` error-correction codewords, highest power first. */
function rsGenerator(degree: number): number[] {
  let polynomial = [1];
  for (let index = 0; index < degree; index++) {
    const next = new Array<number>(polynomial.length + 1).fill(0);
    for (let term = 0; term < polynomial.length; term++) {
      next[term] ^= gfMultiply(polynomial[term]!, EXP[index]!);
      next[term + 1] ^= polynomial[term]!;
    }
    polynomial = next;
  }
  return polynomial;
}

/**
 * Reed-Solomon remainder: the block's error-correction codewords. `rsGenerator` returns the
 * generator low-order-first with its monic leading term last, so the feedback taps read the
 * coefficients in reverse.
 */
export function rsRemainder(data: readonly number[], ecCodewords: number): number[] {
  const generator = rsGenerator(ecCodewords);
  const remainder = new Array<number>(ecCodewords).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0]!;
    remainder.shift();
    remainder.push(0);
    for (let index = 0; index < ecCodewords; index++) {
      remainder[index] ^= gfMultiply(generator[ecCodewords - 1 - index]!, factor);
    }
  }
  return remainder;
}

/** Syndromes of a full codeword block; a valid block evaluates to all zeros. */
export function blockSyndromes(block: readonly number[], ecCodewords: number): number[] {
  const syndromes: number[] = [];
  for (let index = 0; index < ecCodewords; index++) {
    let value = 0;
    for (const byte of block) value = gfMultiply(value, EXP[index]!) ^ byte;
    syndromes.push(value);
  }
  return syndromes;
}

function pickVersion(byteLength: number): number {
  for (let index = 0; index < VERSIONS.length; index++) {
    const spec = VERSIONS[index]!;
    const capacity = spec.dataBlocks.reduce((sum, block) => sum + block, 0);
    // 4-bit mode + 8-bit character count, then the payload and up to 7 bits of terminator.
    if (4 + 8 + byteLength * 8 <= capacity * 8) return index + 1;
  }
  throw new Error(`qr: ${byteLength} bytes exceeds version 10-L capacity`);
}

function utf8(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}

/** Mode indicator 0100, 8-bit length for versions 1..9, then the payload. */
function dataCodewords(bytes: readonly number[], version: number): number[] {
  const spec = VERSIONS[version - 1]!;
  const capacityBits = spec.dataBlocks.reduce((sum, block) => sum + block, 0) * 8;
  const bits: number[] = [];
  const push = (value: number, length: number): void => {
    for (let index = length - 1; index >= 0; index--) bits.push((value >> index) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const byte of bytes) push(byte, 8);
  const terminator = Math.min(4, capacityBits - bits.length);
  push(0, terminator);
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    let value = 0;
    for (let offset = 0; offset < 8; offset++) value = (value << 1) | bits[index + offset]!;
    codewords.push(value);
  }
  // Alternating pad codewords per the standard, starting with 0xEC.
  let pad = 0;
  while (codewords.length < capacityBits / 8) {
    codewords.push(pad % 2 === 0 ? 0xec : 0x11);
    pad += 1;
  }
  return codewords;
}

/** Interleave data and error-correction codewords as the symbol requires. */
function interleave(codewords: readonly number[], version: number): number[] {
  const spec = VERSIONS[version - 1]!;
  const blocks: { data: number[]; ec: number[] }[] = [];
  let cursor = 0;
  for (const size of spec.dataBlocks) {
    const data = codewords.slice(cursor, cursor + size);
    cursor += size;
    blocks.push({ data, ec: rsRemainder(data, spec.ecCodewordsPerBlock) });
  }
  const result: number[] = [];
  const longest = Math.max(...blocks.map(block => block.data.length));
  for (let index = 0; index < longest; index++) {
    for (const block of blocks) if (index < block.data.length) result.push(block.data[index]!);
  }
  for (let index = 0; index < spec.ecCodewordsPerBlock; index++) {
    for (const block of blocks) result.push(block.ec[index]!);
  }
  return result;
}

const FORMAT_GENERATOR = 0x537;
const FORMAT_MASK = 0x5412;
const VERSION_GENERATOR = 0x1f25;

function bch(value: number, generator: number, generatorBits: number): number {
  let remainder = value << generatorBits;
  for (let bit = 31 - Math.clz32(remainder); bit >= generatorBits; bit = 31 - Math.clz32(remainder)) {
    remainder ^= generator << (bit - generatorBits);
  }
  return remainder;
}

function formatBits(levelBits: number, mask: number): number {
  const data = (levelBits << 3) | mask;
  return ((data << 10) | bch(data, FORMAT_GENERATOR, 10)) ^ FORMAT_MASK;
}

function versionBits(version: number): number {
  return (version << 12) | bch(version, VERSION_GENERATOR, 12);
}

function maskBit(mask: number, row: number, column: number): boolean {
  switch (mask) {
    case 0: return (row + column) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return column % 3 === 0;
    case 3: return (row + column) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
    case 5: return ((row * column) % 2) + ((row * column) % 3) === 0;
    case 6: return (((row * column) % 2) + ((row * column) % 3)) % 2 === 0;
    default: return (((row + column) % 2) + ((row * column) % 3)) % 2 === 0;
  }
}

interface Layout {
  readonly modules: (boolean | null)[][];
  readonly reserved: boolean[][];
}

function buildLayout(version: number): Layout {
  const size = version * 4 + 17;
  const modules: (boolean | null)[][] = Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null));
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const placeFinder = (row: number, column: number): void => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const y = row + r;
        const x = column + c;
        if (y < 0 || x < 0 || y >= size || x >= size) continue;
        const edge = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        modules[y]![x] = (r >= 0 && r <= 6 && c >= 0 && c <= 6) && (edge || core);
        reserved[y]![x] = true;
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);
  // Timing patterns.
  for (let index = 8; index < size - 8; index++) {
    modules[6]![index] = index % 2 === 0;
    modules[index]![6] = index % 2 === 0;
    reserved[6]![index] = true;
    reserved[index]![6] = true;
  }
  // Alignment patterns, skipping the three finder corners.
  const spec = VERSIONS[version - 1]!;
  for (const row of spec.alignment) {
    for (const column of spec.alignment) {
      const nearFinder = (row <= 8 && column <= 8) || (row <= 8 && column >= size - 9) || (row >= size - 9 && column <= 8);
      if (nearFinder) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          modules[row + r]![column + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          reserved[row + r]![column + c] = true;
        }
      }
    }
  }
  // Format information areas and the always-dark module.
  for (let index = 0; index <= 8; index++) {
    reserved[8]![index] = true;
    reserved[index]![8] = true;
  }
  for (let index = 0; index < 8; index++) {
    reserved[8]![size - 1 - index] = true;
    reserved[size - 1 - index]![8] = true;
  }
  modules[size - 8]![8] = true;
  if (version >= 7) {
    for (let index = 0; index < 18; index++) {
      const row = Math.floor(index / 3);
      const column = size - 11 + (index % 3);
      modules[row]![column] = false;
      reserved[row]![column] = true;
      modules[column]![row] = false;
      reserved[column]![row] = true;
    }
  }
  return { modules, reserved };
}

function placeData(layout: Layout, codewords: readonly number[], size: number): void {
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  const bit = (): boolean => {
    if (bitIndex >= totalBits) return false;
    const value = (codewords[bitIndex >> 3]! >> (7 - (bitIndex & 7))) & 1;
    bitIndex += 1;
    return value === 1;
  };
  // Two columns at a time, right to left, alternating upward and downward. Column 6 holds the
  // vertical timing pattern, so that pair shifts one column left.
  let upward = true;
  for (let column = size - 1; column >= 1; column -= 2) {
    if (column === 6) column = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const offset of [0, -1]) {
        const x = column + offset;
        if (x < 0 || layout.reserved[row]![x]) continue;
        layout.modules[row]![x] = bit();
      }
    }
    upward = !upward;
  }
}

function applyMask(layout: Layout, size: number, mask: number): boolean[][] {
  return layout.modules.map((row, y) => row.map((value, x) => {
    if (layout.reserved[y]![x]) return value === true;
    return (value === true) !== maskBit(mask, y, x);
  }));
}

function writeFormat(matrix: boolean[][], size: number, levelBits: number, mask: number): void {
  const bits = formatBits(levelBits, mask);
  const bit = (index: number): boolean => ((bits >> index) & 1) === 1;
  // First copy: down the left of the top-left finder, then along the top-right.
  for (let index = 0; index <= 5; index++) matrix[index]![8] = bit(index);
  matrix[7]![8] = bit(6);
  matrix[8]![8] = bit(7);
  matrix[8]![7] = bit(8);
  for (let index = 9; index < 15; index++) matrix[8]![14 - index] = bit(index);
  // Second copy: along the bottom-left, then down the right of the top-right finder.
  for (let index = 0; index < 8; index++) matrix[8]![size - 1 - index] = bit(index);
  for (let index = 8; index < 15; index++) matrix[size - 15 + index]![8] = bit(index);
  matrix[size - 8]![8] = true;
}

function writeVersion(matrix: boolean[][], size: number, version: number): void {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let index = 0; index < 18; index++) {
    const bit = ((bits >> index) & 1) === 1;
    const row = Math.floor(index / 3);
    const column = size - 11 + (index % 3);
    matrix[row]![column] = bit;
    matrix[column]![row] = bit;
  }
}

/** Penalty score from the four standard rules; the lowest-scoring mask wins. */
function penalty(matrix: readonly boolean[][]): number {
  const size = matrix.length;
  let score = 0;
  const runScore = (line: readonly boolean[]): number => {
    let total = 0;
    let run = 1;
    for (let index = 1; index < line.length; index++) {
      if (line[index] === line[index - 1]) {
        run += 1;
        if (run === 5) total += 3;
        else if (run > 5) total += 1;
      } else run = 1;
    }
    return total;
  };
  for (let index = 0; index < size; index++) {
    score += runScore(matrix[index]!);
    score += runScore(matrix.map(row => row[index]!));
  }
  for (let row = 0; row < size - 1; row++) {
    for (let column = 0; column < size - 1; column++) {
      const value = matrix[row]![column]!;
      if (matrix[row]![column + 1] === value && matrix[row + 1]![column] === value && matrix[row + 1]![column + 1] === value) score += 3;
    }
  }
  const finderLike = /10111010000|00001011101/;
  const asBits = (line: readonly boolean[]): string => line.map(value => (value ? '1' : '0')).join('');
  for (let index = 0; index < size; index++) {
    if (finderLike.test(asBits(matrix[index]!))) score += 40;
    if (finderLike.test(asBits(matrix.map(row => row[index]!)))) score += 40;
  }
  const dark = matrix.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

export interface QrCode {
  readonly version: number;
  readonly size: number;
  readonly mask: number;
  readonly matrix: QrMatrix;
}

/** Encode `text` as an ISO/IEC 18004 byte-mode symbol at error-correction level L. */
export function encodeQr(text: string): QrCode {
  const bytes = utf8(text);
  if (bytes.length === 0) throw new Error('qr: empty payload');
  const version = pickVersion(bytes.length);
  const size = version * 4 + 17;
  const codewords = interleave(dataCodewords(bytes, version), version);
  let bestMatrix: boolean[][] = [];
  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    const layout = buildLayout(version);
    placeData(layout, codewords, size);
    const matrix = applyMask(layout, size, mask);
    writeFormat(matrix, size, ECC_L_FORMAT_BITS, mask);
    writeVersion(matrix, size, version);
    const score = penalty(matrix);
    if (score < bestScore) {
      bestScore = score;
      bestMatrix = matrix;
      bestMask = mask;
    }
  }
  return { version, size, mask: bestMask, matrix: bestMatrix };
}

/** UTF-8 bytes behind an encoded symbol, for tests and diagnostics. */
export function qrCodewords(text: string): readonly number[] {
  const bytes = utf8(text);
  const version = pickVersion(bytes.length);
  return interleave(dataCodewords(bytes, version), version);
}

/**
 * Inline SVG. Modules are one path so the DOM stays small; `shape-rendering="crispEdges"` keeps
 * every module a hard square, which is what a scanner needs.
 */
export function qrSvg(text: string, options: { modulePx?: number; quietPx?: number; label?: string } = {}): string {
  const code = encodeQr(text);
  const modulePx = options.modulePx ?? 4;
  const quiet = options.quietPx ?? 4;
  const extent = (code.size + quiet * 2) * modulePx;
  const squares: string[] = [];
  for (let row = 0; row < code.size; row++) {
    let runStart = -1;
    for (let column = 0; column <= code.size; column++) {
      const dark = column < code.size && code.matrix[row]![column]!;
      if (dark && runStart < 0) runStart = column;
      if (!dark && runStart >= 0) {
        squares.push(`M${(runStart + quiet) * modulePx} ${(row + quiet) * modulePx}h${(column - runStart) * modulePx}v${modulePx}h-${(column - runStart) * modulePx}z`);
        runStart = -1;
      }
    }
  }
  const label = options.label ?? 'Join link QR code';
  return `<svg class="qr" viewBox="0 0 ${extent} ${extent}" width="${extent}" height="${extent}" role="img" aria-label="${label}" shape-rendering="crispEdges" data-qr-version="${code.version}"><rect width="${extent}" height="${extent}" fill="#dfebe9"/><path d="${squares.join('')}" fill="#050b12"/></svg>`;
}
