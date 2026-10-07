import { deflateRawSync, inflateRawSync } from "node:zlib";

export type ZipEntry = { name: string; data: Buffer };
export type ZipLimits = { maxEntries: number; maxTotalBytes: number };

export const ZIP_LIMITS: ZipLimits = {
  maxEntries: 10_000,
  maxTotalBytes: 1024 ** 3,
};

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const UTF8_FLAG = 0x0800;
const DOS_DATE_1980_01_01 = (0 << 9) | (1 << 5) | 1;

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Writes a ZIP archive; each entry is deflated when that makes it smaller. */
export function writeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const deflated = deflateRawSync(entry.data);
    const method = deflated.length < entry.data.length ? 8 : 0;
    const data = method === 8 ? deflated : entry.data;
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/**
 * Reads the files in a ZIP archive (stored or deflated entries). Directory
 * entries are skipped. Encrypted, ZIP64, and symlink entries are rejected, and
 * sizes are checked against `limits` before anything is decompressed.
 */
export function readZip(zip: Buffer, limits: ZipLimits = ZIP_LIMITS): ZipEntry[] {
  const invalid = (detail: string): never => {
    throw new Error(`Not a valid ZIP file: ${detail}.`);
  };
  let end = -1;
  for (let index = zip.length - 22; index >= Math.max(0, zip.length - 22 - 0xffff); index--)
    if (zip.readUInt32LE(index) === END_OF_CENTRAL_DIRECTORY) {
      end = index;
      break;
    }
  if (end < 0) invalid("end of central directory not found");
  const count = zip.readUInt16LE(end + 10);
  const directorySize = zip.readUInt32LE(end + 12);
  const directoryOffset = zip.readUInt32LE(end + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff)
    throw new Error("ZIP64 archives are not supported. Re-create the ZIP with fewer or smaller files.");
  if (directoryOffset + directorySize > end) invalid("central directory is out of range");
  if (count > limits.maxEntries)
    throw new Error(`The ZIP has ${count} entries; the limit is ${limits.maxEntries}.`);

  const entries: ZipEntry[] = [];
  let totalBytes = 0;
  let position = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (position + 46 > end || zip.readUInt32LE(position) !== CENTRAL_HEADER)
      invalid("central directory entry is corrupt");
    const flags = zip.readUInt16LE(position + 8);
    const method = zip.readUInt16LE(position + 10);
    const crc = zip.readUInt32LE(position + 16);
    const compressedSize = zip.readUInt32LE(position + 20);
    const size = zip.readUInt32LE(position + 24);
    const nameLength = zip.readUInt16LE(position + 28);
    const extraLength = zip.readUInt16LE(position + 30);
    const commentLength = zip.readUInt16LE(position + 32);
    const mode = zip.readUInt32LE(position + 38) >>> 16;
    const localOffset = zip.readUInt32LE(position + 42);
    const name = zip
      .subarray(position + 46, position + 46 + nameLength)
      .toString(flags & UTF8_FLAG ? "utf8" : "latin1");
    position += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw new Error(`Encrypted ZIP entries are not supported: ${name}`);
    if ((mode & 0o170000) === 0o120000)
      throw new Error(`Symlinks are not allowed in dataset ZIPs: ${name}`);
    if (size === 0xffffffff || compressedSize === 0xffffffff)
      throw new Error("ZIP64 archives are not supported. Re-create the ZIP with fewer or smaller files.");
    totalBytes += size;
    if (totalBytes > limits.maxTotalBytes)
      throw new Error(
        `The ZIP expands to more than ${Math.round(limits.maxTotalBytes / 1024 ** 2)} MB.`,
      );
    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== LOCAL_HEADER)
      invalid(`local header for ${name} is corrupt`);
    const dataStart =
      localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > zip.length) invalid(`${name} is truncated`);
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
      } catch {
        return invalid(`${name} could not be decompressed`);
      }
    } else
      throw new Error(
        `Unsupported compression in ${name}. Use a standard ZIP (stored or deflate).`,
      );
    if (data.length !== size || crc32(data) !== crc) invalid(`${name} failed its integrity check`);
    entries.push({ name, data });
  }
  return entries;
}
