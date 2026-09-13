import { inflateRawSync } from "node:zlib";

export class ResourcePackageError extends Error {
  constructor(message: string, readonly code = "INVALID_RESOURCE_PACKAGE", readonly status = 400) {
    super(message); this.name = "ResourcePackageError";
  }
}

export type ArchiveEntry = { name: string; size: number; read: () => Buffer };
export const RESOURCE_PACKAGE_ARCHIVE_LIMITS = {
  compressedBytes: 50 * 1024 * 1024, expandedBytes: 250 * 1024 * 1024,
  entryBytes: 64 * 1024 * 1024, entries: 2048,
};

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}

/** Inspect the central directory before any inflation; never extract paths to disk. */
export function readBoundedZip(bytes: Buffer, limits = RESOURCE_PACKAGE_ARCHIVE_LIMITS): ArchiveEntry[] {
  const invalid = (message = "资源包 ZIP 已损坏，或使用了不支持的压缩格式。") => new ResourcePackageError(message);
  if (bytes.length > limits.compressedBytes) throw invalid("资源包不能超过 50 MiB。");
  try {
    let end = bytes.length - 22;
    const minimum = Math.max(0, end - 65535);
    for (; end >= minimum; end--) {
      if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break;
    }
    if (end < minimum || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw invalid();
    const count = bytes.readUInt16LE(end + 10);
    const directorySize = bytes.readUInt32LE(end + 12);
    let offset = bytes.readUInt32LE(end + 16);
    if (count !== bytes.readUInt16LE(end + 8) || count === 65535 || count > limits.entries) throw invalid("资源包中的文件条目过多，或使用了不支持的 ZIP64 格式。");
    if (offset + directorySize !== end) throw invalid();
    let totalSize = 0;
    const names = new Set<string>();
    const entries: ArchiveEntry[] = [];
    for (let index = 0; index < count; index++) {
      if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw invalid();
      const flags = bytes.readUInt16LE(offset + 8);
      const method = bytes.readUInt16LE(offset + 10);
      const checksum = bytes.readUInt32LE(offset + 16);
      const compressed = bytes.readUInt32LE(offset + 20);
      const size = bytes.readUInt32LE(offset + 24);
      const nameLength = bytes.readUInt16LE(offset + 28);
      const extraLength = bytes.readUInt16LE(offset + 30);
      const commentLength = bytes.readUInt16LE(offset + 32);
      const attributes = bytes.readUInt32LE(offset + 38);
      const localOffset = bytes.readUInt32LE(offset + 42);
      const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
      const name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes).normalize("NFC");
      offset += 46 + nameLength + extraLength + commentLength;
      if (offset > end || !name || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)
        || name.split("/").some((part) => part === ".." || part === ".") || names.has(name)) throw invalid("资源包包含不安全或重复的文件路径。");
      names.add(name);
      if ((flags & 1) || ![0, 8].includes(method) || ((attributes >>> 16) & 0xf000) === 0xa000) throw invalid("资源包不能包含加密文件或符号链接。");
      totalSize += size;
      if (size > limits.entryBytes || totalSize > limits.expandedBytes) throw invalid("资源包展开后过大，请减少附件或图片后重试。");
      if (localOffset + 30 > end || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw invalid();
      const localNameLength = bytes.readUInt16LE(localOffset + 26);
      const localExtraLength = bytes.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      if (!bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes)
        || dataOffset + compressed > end || bytes.readUInt16LE(localOffset + 8) !== method) throw invalid();
      if (name.endsWith("/")) continue;
      entries.push({ name, size, read() {
        try {
          const payload = bytes.subarray(dataOffset, dataOffset + compressed);
          const output = method === 0 ? Buffer.from(payload) : inflateRawSync(payload, { maxOutputLength: Math.max(1, Math.min(size, limits.entryBytes)) });
          if (output.length !== size || crc32(output) !== checksum) throw invalid();
          return output;
        } catch (error) { if (error instanceof ResourcePackageError) throw error; throw invalid(); }
      } });
    }
    if (offset !== end) throw invalid();
    return entries;
  } catch (error) { if (error instanceof ResourcePackageError) throw error; throw invalid(); }
}
