/**
 * Dependency-free QR Code encoder for the host's guest LAN URL. `encodeQr` writes the code,
 * `qrToText` renders it for a terminal, `readQr` decodes a matrix back — the host only needs the
 * first two; the verifier exists so a test can prove the Reed-Solomon bytes are real.
 *
 * Byte mode only (mode 0100), versions 1..20, algorithms per ISO/IEC 18004.
 */

export interface QrMatrix {
  readonly size: number;
  readonly modules: readonly (readonly boolean[])[];
}

export type EcLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrReadResult {
  readonly text: string;
  readonly version: number;
  readonly ecLevel: string;
  readonly mask: number;
  readonly syndromesOk: boolean;
}

const EC_ORDER: readonly EcLevel[] = ['L', 'M', 'Q', 'H'];
/** Format-information bit pair per level: L=01, M=00, Q=11, H=10. */
const EC_FORMAT: Readonly<Record<EcLevel, number>> = { L: 1, M: 0, Q: 3, H: 2 };
const EC_FROM_FORMAT: readonly EcLevel[] = ['M', 'L', 'H', 'Q'];

/**
 * Versions 1..20, each row four EC levels in L,M,Q,H order, each five numbers:
 * `[ecCodewordsPerBlock, blocks1, dataCodewords1, blocks2, dataCodewords2]`.
 * Group 2 has zero blocks when both of its numbers are zero.
 */
const RS_TABLE: readonly (readonly number[])[] = [
  [7, 1, 19, 0, 0, 10, 1, 16, 0, 0, 13, 1, 13, 0, 0, 17, 1, 9, 0, 0], // 1
  [10, 1, 34, 0, 0, 16, 1, 28, 0, 0, 22, 1, 22, 0, 0, 28, 1, 16, 0, 0], // 2
  [15, 1, 55, 0, 0, 26, 1, 44, 0, 0, 18, 2, 17, 0, 0, 22, 2, 13, 0, 0], // 3
  [20, 1, 80, 0, 0, 18, 2, 32, 0, 0, 26, 2, 24, 0, 0, 16, 4, 9, 0, 0], // 4
  [26, 1, 108, 0, 0, 24, 2, 43, 0, 0, 18, 2, 15, 2, 16, 22, 2, 11, 2, 12], // 5
  [18, 2, 68, 0, 0, 16, 4, 27, 0, 0, 24, 4, 19, 0, 0, 28, 4, 15, 0, 0], // 6
  [20, 2, 78, 0, 0, 18, 4, 31, 0, 0, 18, 2, 14, 4, 15, 26, 4, 13, 1, 14], // 7
  [24, 2, 97, 0, 0, 22, 2, 38, 2, 39, 22, 4, 18, 2, 19, 26, 4, 14, 2, 15], // 8
  [30, 2, 116, 0, 0, 22, 3, 36, 2, 37, 20, 4, 16, 4, 17, 24, 4, 12, 4, 13], // 9
  [18, 2, 68, 2, 69, 26, 4, 43, 1, 44, 24, 6, 19, 2, 20, 28, 6, 15, 2, 16], // 10
  [20, 4, 81, 0, 0, 30, 1, 50, 4, 51, 28, 4, 22, 4, 23, 24, 3, 12, 8, 13], // 11
  [24, 2, 92, 2, 93, 22, 6, 36, 2, 37, 26, 4, 20, 6, 21, 28, 7, 14, 4, 15], // 12
  [26, 4, 107, 0, 0, 22, 8, 37, 1, 38, 24, 8, 20, 4, 21, 22, 12, 11, 4, 12], // 13
  [30, 3, 115, 1, 116, 24, 4, 40, 5, 41, 20, 11, 16, 5, 17, 24, 11, 12, 5, 13], // 14
  [22, 5, 87, 1, 88, 24, 5, 41, 5, 42, 30, 5, 24, 7, 25, 24, 11, 12, 7, 13], // 15
  [24, 5, 98, 1, 99, 28, 7, 45, 3, 46, 24, 15, 19, 2, 20, 30, 3, 15, 13, 16], // 16
  [28, 1, 107, 5, 108, 28, 10, 46, 1, 47, 28, 1, 22, 15, 23, 28, 2, 14, 17, 15], // 17
  [30, 5, 120, 1, 121, 26, 9, 43, 4, 44, 28, 17, 22, 1, 23, 28, 2, 14, 19, 15], // 18
  [28, 3, 113, 4, 114, 26, 3, 44, 11, 45, 26, 17, 21, 4, 22, 26, 9, 13, 16, 14], // 19
  [28, 3, 107, 5, 108, 26, 3, 41, 13, 42, 30, 15, 24, 5, 25, 28, 15, 15, 10, 16], // 20
];

/** Alignment-pattern center coordinates per version; version 1 has none. */
const ALIGN_TABLE: readonly (readonly number[])[] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46],
  [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
  [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
];

interface RsParams {
  ecPerBlock: number;
  blocks1: number;
  data1: number;
  blocks2: number;
  data2: number;
}

function rsParams(version: number, ec: EcLevel): RsParams {
  const row = RS_TABLE[version - 1];
  const i = EC_ORDER.indexOf(ec) * 5;
  return {
    ecPerBlock: row[i],
    blocks1: row[i + 1],
    data1: row[i + 2],
    blocks2: row[i + 3],
    data2: row[i + 4],
  };
}

function dataCodewords(version: number, ec: EcLevel): number {
  const p = rsParams(version, ec);
  return p.blocks1 * p.data1 + p.blocks2 * p.data2;
}

/** Byte-mode character-count indicator width. */
function countBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

// --- GF(256) arithmetic with primitive polynomial 0x11D ---

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** Product of (x - r^i) for i in 0..degree-1, leading 1 dropped: the RS generator. */
function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}

/** Polynomial remainder of `data` divided by `divisor` — the EC codewords, or zero syndromes. */
function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const n = divisor.length;
  const result = new Array<number>(n).fill(0);
  for (let d = 0; d < data.length; d++) {
    const factor = data[d] ^ result[0];
    for (let i = 0; i < n - 1; i++) result[i] = result[i + 1];
    result[n - 1] = 0;
    if (factor !== 0) for (let i = 0; i < n; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

function pushBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

function maskBit(mask: number, y: number, x: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/** Visits every data module in the standard zigzag (bottom-right, alternating upward). */
function forEachDataModule(
  size: number,
  isFunction: readonly (readonly boolean[])[],
  visit: (y: number, x: number) => void,
): void {
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x]) visit(y, x);
      }
    }
  }
}

class QrBuilder {
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];

  constructor(
    readonly version: number,
    readonly ec: EcLevel,
  ) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.drawFunctionPatterns();
  }

  /** Column `x`, row `y`. */
  private setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }

  private drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) this.setFunction(x, y, dist !== 2 && dist !== 4);
      }
    }
  }

  private drawAlignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  private drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);

    const align = ALIGN_TABLE[this.version - 1];
    for (let i = 0; i < align.length; i++) {
      for (let j = 0; j < align.length; j++) {
        const corner = (i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0);
        if (!corner) this.drawAlignment(align[i], align[j]);
      }
    }

    this.drawFormatBits(0); // placeholder; the chosen mask rewrites these
    this.drawVersionBits();
  }

  drawFormatBits(mask: number): void {
    const data = (EC_FORMAT[this.ec] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;

    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
    this.setFunction(8, 7, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));

    for (let i = 0; i < 8; i++) this.setFunction(this.size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFunction(8, this.size - 15 + i, bit(i));
    this.setFunction(8, this.size - 8, true); // dark module
  }

  private drawVersionBits(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, dark);
      this.setFunction(b, a, dark);
    }
  }

  drawCodewords(data: readonly number[]): void {
    let i = 0;
    const limit = data.length * 8;
    forEachDataModule(this.size, this.isFunction, (y, x) => {
      if (i < limit) {
        this.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
        i++;
      }
    });
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.isFunction[y][x] && maskBit(mask, y, x)) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  /** Lowest-index mask with the lowest penalty; N1=3, N2=3, N3=40, N4=10. */
  bestMask(): number {
    let best = 0;
    let min = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      this.applyMask(mask);
      this.drawFormatBits(mask);
      const score = this.penaltyScore();
      if (score < min) {
        min = score;
        best = mask;
      }
      this.applyMask(mask);
    }
    this.drawFormatBits(0);
    return best;
  }

  /** N1=3, N2=3, N3=40, N4=10, straight from ISO/IEC 18004 table 24. */
  private penaltyScore(): number {
    const size = this.size;
    const m = this.modules;
    let result = 0;

    // N1: runs of five or more same-coloured modules in a row or column.
    for (let y = 0; y < size; y++) {
      for (const vertical of [false, true]) {
        let run = 1;
        for (let i = 1; i < size; i++) {
          const now = vertical ? m[i][y] : m[y][i];
          const prev = vertical ? m[i - 1][y] : m[y][i - 1];
          if (now === prev) run++;
          else {
            if (run >= 5) result += 3 + (run - 5);
            run = 1;
          }
        }
        if (run >= 5) result += 3 + (run - 5);
      }
    }

    // N2: 2x2 blocks of one colour.
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += 3;
      }
    }

    // N3: 1:1:3:1:1 with a light area four modules wide on either side — the quiet zone outside the
    // symbol counts as light, which is what scanner implementations do.
    const dark = (y: number, x: number): boolean => y >= 0 && y < size && x >= 0 && x < size && m[y][x];
    const lightArea = (line: number, from: number, to: number, vertical: boolean): boolean => {
      for (let i = from; i < to; i++) if (dark(vertical ? i : line, vertical ? line : i)) return false;
      return true;
    };
    for (let line = 0; line < size; line++) {
      for (const vertical of [false, true]) {
        const at = (i: number): boolean => dark(vertical ? i : line, vertical ? line : i);
        for (let i = 0; i + 6 < size; i++) {
          const core = at(i) && !at(i + 1) && at(i + 2) && at(i + 3) && at(i + 4) && !at(i + 5) && at(i + 6);
          if (core && (lightArea(line, i - 4, i, vertical) || lightArea(line, i + 7, i + 11, vertical))) result += 40;
        }
      }
    }

    // N4: deviation of the dark-module share from 50%, in 5% steps.
    let darkCount = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (m[y][x]) darkCount++;
    const total = size * size;
    result += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
    return result;
  }
}

function assembleData(bytes: Uint8Array, version: number, params: RsParams): number[] {
  const capacity = (params.blocks1 * params.data1 + params.blocks2 * params.data2) * 8;
  const bits: number[] = [];
  pushBits(bits, 0b0100, 4);
  pushBits(bits, bytes.length, countBits(version));
  for (let i = 0; i < bytes.length; i++) pushBits(bits, bytes[i], 8);
  pushBits(bits, 0, Math.min(4, capacity - bits.length)); // terminator
  pushBits(bits, 0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) pushBits(bits, pad, 8);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j++) value = (value << 1) | bits[i + j];
    codewords.push(value);
  }
  return codewords;
}

/** Splits into RS blocks, appends EC codewords, then interleaves both halves. */
function interleave(data: readonly number[], params: RsParams): number[] {
  const divisor = rsDivisor(params.ecPerBlock);
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let pos = 0;
  for (let i = 0; i < params.blocks1; i++) {
    const block = data.slice(pos, pos + params.data1);
    pos += params.data1;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, divisor));
  }
  for (let i = 0; i < params.blocks2; i++) {
    const block = data.slice(pos, pos + params.data2);
    pos += params.data2;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, divisor));
  }

  const out: number[] = [];
  for (let i = 0; i < params.data1 + 1; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < params.ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return out;
}

export function encodeQr(text: string, ecLevel: EcLevel = 'M'): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= 20; v++) {
    if (4 + countBits(v) + bytes.length * 8 <= dataCodewords(v, ecLevel) * 8) {
      version = v;
      break;
    }
  }
  if (version === 0) {
    const max = dataCodewords(20, ecLevel) - 3;
    throw new RangeError(`qr: ${bytes.length} bytes do not fit version 20 at EC level ${ecLevel} (max ${max})`);
  }

  const params = rsParams(version, ecLevel);
  const codewords = interleave(assembleData(bytes, version, params), params);
  const code = new QrBuilder(version, ecLevel);
  code.drawCodewords(codewords);
  const mask = code.bestMask();
  code.applyMask(mask);
  code.drawFormatBits(mask);
  return { size: code.size, modules: code.modules };
}

/** Half-block rows: two module rows per text row, so a terminal's 1:2 cells keep the aspect. */
export function qrToText(matrix: QrMatrix, quietZone = 4): string {
  const size = matrix.size;
  const blank = ' '.repeat(size + quietZone * 2);
  const lines: string[] = [];
  for (let i = 0; i < quietZone; i++) lines.push(blank);
  for (let y = 0; y < size; y += 2) {
    let line = ' '.repeat(quietZone);
    for (let x = 0; x < size; x++) {
      const top = matrix.modules[y][x];
      const bottom = y + 1 < size && matrix.modules[y + 1][x];
      line += top ? (bottom ? '\u2588' : '\u2580') : bottom ? '\u2584' : ' ';
    }
    lines.push(line + ' '.repeat(quietZone));
  }
  for (let i = 0; i < quietZone; i++) lines.push(blank);
  return lines.join('\n');
}

/** BCH(15,5) remainder, generator 0x537 — recomputed to check the format bits read back. */
function formatRemainder(data: number): number {
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return rem;
}

function versionRemainder(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return rem;
}

export function readQr(matrix: QrMatrix): QrReadResult {
  const size = matrix.size;
  if (size < 21 || size > 97 || (size - 17) % 4 !== 0) {
    throw new RangeError(`qr: matrix size ${size} is not a version 1..20 code`);
  }
  const version = (size - 17) / 4;
  // Only the function-module map matters here; the drawn values are a throwaway placeholder.
  const shape = new QrBuilder(version, 'M');

  const at = (y: number, x: number): number => (matrix.modules[y][x] ? 1 : 0);
  const readFormat = (copy: 0 | 1): number => {
    let raw = 0;
    if (copy === 0) {
      for (let i = 0; i <= 5; i++) raw |= at(i, 8) << i;
      raw |= at(7, 8) << 6;
      raw |= at(8, 8) << 7;
      raw |= at(8, 7) << 8;
      for (let i = 9; i < 15; i++) raw |= at(8, 14 - i) << i;
    } else {
      for (let i = 0; i < 8; i++) raw |= at(8, size - 1 - i) << i;
      for (let i = 8; i < 15; i++) raw |= at(size - 15 + i, 8) << i;
    }
    return raw;
  };

  const validFormat = (raw: number): boolean => {
    const data = raw ^ 0x5412;
    return (((data >>> 10) << 10) | formatRemainder(data >>> 10)) === data;
  };
  let rawFormat = readFormat(0);
  if (!validFormat(rawFormat)) {
    rawFormat = readFormat(1);
    if (!validFormat(rawFormat)) throw new Error('qr: format information fails its BCH check');
  }
  const formatData = (rawFormat ^ 0x5412) >>> 10;
  const ecLevel = EC_FROM_FORMAT[formatData >>> 3];
  const mask = formatData & 7;

  if (version >= 7) {
    let bits = 0;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      bits |= at(b, a) << i;
      if (at(a, b) !== at(b, a)) throw new Error('qr: version information copies disagree');
    }
    if ((((bits >>> 12) << 12) | versionRemainder(bits >>> 12)) !== bits || bits >>> 12 !== version) {
      throw new Error('qr: version information fails its BCH check');
    }
  }

  // Unmask, then walk the same zigzag the encoder used.
  const unmasked = matrix.modules.map((row) => row.slice() as boolean[]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!shape.isFunction[y][x] && maskBit(mask, y, x)) unmasked[y][x] = !unmasked[y][x];
    }
  }

  const params = rsParams(version, ecLevel);
  const total = params.blocks1 * (params.data1 + params.ecPerBlock) + params.blocks2 * (params.data2 + params.ecPerBlock);
  const bits: number[] = [];
  forEachDataModule(size, shape.isFunction, (y, x) => {
    if (bits.length < total * 8) bits.push(unmasked[y][x] ? 1 : 0);
  });
  if (bits.length < total * 8) throw new Error('qr: matrix is missing data modules');
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j++) value = (value << 1) | bits[i + j];
    codewords.push(value);
  }

  // De-interleave: data codewords column-wise across blocks, then EC codewords the same way.
  const dataLens: number[] = [];
  for (let i = 0; i < params.blocks1; i++) dataLens.push(params.data1);
  for (let i = 0; i < params.blocks2; i++) dataLens.push(params.data2);
  const dataBlocks = dataLens.map((len) => new Array<number>(len).fill(0));
  const ecBlocks = dataLens.map(() => new Array<number>(params.ecPerBlock).fill(0));
  let pos = 0;
  for (let i = 0; i < params.data1 + 1; i++) {
    for (let b = 0; b < dataBlocks.length; b++) if (i < dataLens[b]) dataBlocks[b][i] = codewords[pos++];
  }
  for (let i = 0; i < params.ecPerBlock; i++) {
    for (let b = 0; b < ecBlocks.length; b++) ecBlocks[b][i] = codewords[pos++];
  }

  const divisor = rsDivisor(params.ecPerBlock);
  let syndromesOk = true;
  for (let b = 0; b < dataBlocks.length; b++) {
    const syndrome = rsRemainder(dataBlocks[b].concat(ecBlocks[b]), divisor);
    for (const value of syndrome) if (value !== 0) syndromesOk = false;
  }

  const stream: number[] = [];
  for (const block of dataBlocks) for (const cw of block) pushBits(stream, cw, 8);
  let cursor = 0;
  const take = (n: number): number => {
    if (cursor + n > stream.length) throw new Error('qr: payload runs past the data codewords');
    let value = 0;
    for (let i = 0; i < n; i++) value = (value << 1) | stream[cursor++];
    return value;
  };
  const mode = take(4);
  if (mode !== 0b0100) throw new Error(`qr: unsupported mode indicator ${mode}`);
  const length = take(countBits(version));
  const payload = new Uint8Array(length);
  for (let i = 0; i < length; i++) payload[i] = take(8);

  return { text: new TextDecoder().decode(payload), version, ecLevel, mask, syndromesOk };
}
