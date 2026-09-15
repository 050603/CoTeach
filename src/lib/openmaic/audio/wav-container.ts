/**
 * WAV container repair shared by generation, storage serving and browser
 * playback. Some streaming TTS APIs return a complete WAV file in a field
 * documented as raw PCM. Wrapping that response again makes the inner RIFF
 * header audible as a loud click at the start of every narration segment.
 */

function bytesToAscii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.byteLength) return '';
  let value = '';
  for (let index = 0; index < length; index++) {
    value += String.fromCharCode(bytes[offset + index]);
  }
  return value;
}

export function hasWavHeader(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 12
    && bytesToAscii(bytes, 0, 4) === 'RIFF'
    && bytesToAscii(bytes, 8, 4) === 'WAVE'
  );
}

function wavDataOffset(bytes: Uint8Array): number | undefined {
  if (!hasWavHeader(bytes)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = bytesToAscii(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;
    if (chunkId === 'data') return chunkDataOffset;

    const nextOffset = chunkDataOffset + chunkSize + (chunkSize % 2);
    if (nextOffset <= offset || nextOffset > bytes.byteLength) return undefined;
    offset = nextOffset;
  }

  return undefined;
}

/**
 * Return a standalone, browser-playable WAV container.
 *
 * Besides replacing streaming sentinel sizes, this unwraps accidental nested
 * WAV containers. The input is never mutated, which keeps cached/source blobs
 * safe when the normalized bytes are shorter than the original file.
 */
export function normalizePlayableWav(audio: Uint8Array): Uint8Array {
  if (!hasWavHeader(audio)) return audio;

  let container = audio;
  // A provider should only ever add one redundant wrapper. Keep a small bound
  // so corrupt/adversarial files cannot make normalization loop indefinitely.
  for (let depth = 0; depth < 4; depth++) {
    const dataOffset = wavDataOffset(container);
    if (dataOffset === undefined) break;
    const payload = container.subarray(dataOffset);
    if (!hasWavHeader(payload)) break;
    container = payload;
  }

  const normalized = new Uint8Array(container);
  const dataOffset = wavDataOffset(normalized);
  if (dataOffset === undefined) return normalized;

  const view = new DataView(
    normalized.buffer,
    normalized.byteOffset,
    normalized.byteLength,
  );
  view.setUint32(4, normalized.byteLength - 8, true);
  view.setUint32(dataOffset - 4, normalized.byteLength - dataOffset, true);
  return normalized;
}
