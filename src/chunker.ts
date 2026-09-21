export interface ChunkRange {
  start: number;
  end: number;
}

export const WHOLE_FILE_THRESHOLD = 4 * 1024 * 1024;
const MIN_CHUNK = 256 * 1024;
const MAX_CHUNK = 4 * 1024 * 1024;
const AVERAGE_MASK = (1 << 20) - 1;

const GEAR = buildGearTable();

/**
 * A compact FastCDC-style content-defined chunker. Boundaries are determined by
 * file bytes, so inserting data does not shift every later chunk boundary.
 */
export function chunkRanges(bytes: Uint8Array): ChunkRange[] {
  if (bytes.length <= WHOLE_FILE_THRESHOLD) {
    return [{ start: 0, end: bytes.length }];
  }

  const result: ChunkRange[] = [];
  let start = 0;
  while (start < bytes.length) {
    const maximum = Math.min(start + MAX_CHUNK, bytes.length);
    let cursor = Math.min(start + MIN_CHUNK, maximum);
    let fingerprint = 0;

    while (cursor < maximum) {
      fingerprint = ((fingerprint << 1) + GEAR[bytes[cursor]]) >>> 0;
      cursor += 1;
      if ((fingerprint & AVERAGE_MASK) === 0) {
        break;
      }
    }

    result.push({ start, end: cursor });
    start = cursor;
  }
  return result;
}

function buildGearTable(): Uint32Array {
  const table = new Uint32Array(256);
  let state = 0x9e3779b9;
  for (let index = 0; index < table.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    table[index] = state >>> 0;
  }
  return table;
}
