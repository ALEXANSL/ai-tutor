import "server-only";
import { inflateRawSync } from "node:zlib";
import { MAX_COURSE_ZIP_BYTES } from "@/lib/upload-limits";

export interface CourseZipLimits {
  compressedBytes: number;
  expandedBytes: number;
  entryBytes: number;
  jsonBytes: number;
  entries: number;
  ratio: number;
  processingMs: number;
}
export const COURSE_ZIP_LIMITS: Readonly<CourseZipLimits> = {
  compressedBytes: MAX_COURSE_ZIP_BYTES,
  expandedBytes: 256 * 1024 * 1024,
  entryBytes: 64 * 1024 * 1024,
  jsonBytes: 16 * 1024 * 1024,
  entries: 8000,
  ratio: 1000,
  processingMs: 20_000,
};

const decoder = new TextDecoder("utf-8", { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pathFor(raw: string): string {
  if (!raw || /\0|^[a-z][a-z\d+.-]*:|^[\\/]/i.test(raw)) throw new Error("ZIP містить неприпустимий абсолютний шлях або NUL.");
  const parts = raw.replace(/\\/g, "/").split("/");
  if (parts.includes("..")) throw new Error("ZIP містить шлях із '..'. Збережіть файли лише всередині папки курсу.");
  return parts.filter(part => part && part !== ".").join("/");
}

/** Validate the complete central directory before inflating anything. The
 * inflater has an independent output limit, so false ZIP size headers cannot
 * allocate arbitrary memory. No files are written or executed. ZIP64/encrypted
 * archives are deliberately unsupported within this bounded upload contract. */
export function readSafeCourseZip(bytes: Uint8Array, overrides: Partial<CourseZipLimits> = {}): Record<string, Uint8Array> {
  const limits = { ...COURSE_ZIP_LIMITS, ...overrides };
  const began = Date.now();
  if (bytes.byteLength > limits.compressedBytes) throw new Error("ZIP завеликий: максимальний розмір архіву — 300 МіБ.");
  if (bytes.byteLength < 22) throw new Error("Файл не є повним ZIP-архівом.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const checkRange = (offset: number, length: number) => {
    if (offset < 0 || length < 0 || offset + length > bytes.length) throw new Error("ZIP пошкоджений: запис виходить за межі архіву.");
  };
  let end = -1;
  for (let position = bytes.length - 22; position >= Math.max(0, bytes.length - 65557); position--) {
    if (view.getUint32(position, true) === 0x06054b50 && position + 22 + view.getUint16(position + 20, true) === bytes.length) { end = position; break; }
  }
  if (end < 0) throw new Error("ZIP пошкоджений: не знайдено каталог архіву.");
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count) throw new Error("Багатотомний ZIP не підтримується. Створіть один архів.");
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("ZIP64 не підтримується. Створіть звичайний ZIP у межах ліміту.");
  if (!count || count > limits.entries) throw new Error(`ZIP має неприпустиму кількість файлів (максимум ${limits.entries}).`);
  if (centralOffset + centralSize !== end) throw new Error("ZIP пошкоджений: некоректний центральний каталог.");
  checkRange(centralOffset, centralSize);
  const entries: { path: string; start: number; size: number; expanded: number; crc: number; method: number; local: number; directory: boolean }[] = [];
  const seen = new Set<string>();
  let position = centralOffset;
  let expandedTotal = 0;
  for (let index = 0; index < count; index++) {
    if (Date.now() - began > limits.processingMs) throw new Error("Перевірка ZIP перевищила час. Розділіть великий курс на менші пакети.");
    checkRange(position, 46);
    if (view.getUint32(position, true) !== 0x02014b50) throw new Error("ZIP пошкоджений: некоректний запис каталогу.");
    const flags = view.getUint16(position + 8, true);
    const method = view.getUint16(position + 10, true);
    const crc = view.getUint32(position + 16, true);
    const size = view.getUint32(position + 20, true);
    const expanded = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    const disk = view.getUint16(position + 34, true);
    const mode = (view.getUint32(position + 38, true) >>> 16) & 0xf000;
    const local = view.getUint32(position + 42, true);
    if (flags & 1 || flags & 64) throw new Error("ZIP із паролем або шифруванням не підтримується.");
    if (![0, 8].includes(method)) throw new Error("ZIP використовує непідтримуване стиснення. Оберіть стандартний ZIP/Deflate.");
    if (disk || [size, expanded, local].includes(0xffffffff)) throw new Error("Багатотомний ZIP або ZIP64 не підтримується.");
    if (![0, 0x8000, 0x4000].includes(mode)) throw new Error("ZIP містить symlink або спеціальний файл; дозволені лише звичайні файли й папки.");
    if (!nameLength || nameLength > 4096) throw new Error("ZIP містить неприпустиму назву файлу.");
    checkRange(position + 46, nameLength + extraLength + commentLength);
    let raw: string;
    try { raw = decoder.decode(bytes.subarray(position + 46, position + 46 + nameLength)); }
    catch { throw new Error("Назви файлів ZIP мають бути в UTF-8. Перепакуйте архів зі збереженням українських назв."); }
    const path = pathFor(raw);
    const directory = /[\\/]$/.test(raw);
    if (seen.has(path)) throw new Error(`У ZIP дублюється шлях «${path.slice(0, 160)}». Залиште один файл із цією назвою.`);
    seen.add(path);
    if (!path && !directory) throw new Error("ZIP містить порожній шлях файлу.");
    if (directory && expanded) throw new Error("ZIP пошкоджений: папка містить дані файлу.");
    const entryLimit = /\.(?:json|jsonl)$/i.test(path) ? Math.min(limits.entryBytes, limits.jsonBytes) : limits.entryBytes;
    expandedTotal += expanded;
    if (expanded > entryLimit || expandedTotal > limits.expandedBytes) throw new Error("Розпакований курс завеликий або один файл перевищує ліміт. Зменште обсяг пакета.");
    if (expanded > Math.max(1, size) * limits.ratio) throw new Error("ZIP має надмірний коефіцієнт стиснення й не може бути безпечно розпакований.");
    checkRange(local, 30);
    if (view.getUint32(local, true) !== 0x04034b50 || view.getUint16(local + 8, true) !== method || view.getUint16(local + 6, true) !== flags) throw new Error("ZIP пошкоджений: заголовки файлу не збігаються.");
    const localNameLength = view.getUint16(local + 26, true);
    const localExtraLength = view.getUint16(local + 28, true);
    checkRange(local + 30, localNameLength + localExtraLength);
    if (localNameLength !== nameLength || !bytes.subarray(local + 30, local + 30 + localNameLength).every((byte, at) => byte === bytes[position + 46 + at])) throw new Error("ZIP пошкоджений: назви файлу в заголовках не збігаються.");
    if (!(flags & 8) && (view.getUint32(local + 14, true) !== crc || view.getUint32(local + 18, true) !== size || view.getUint32(local + 22, true) !== expanded)) throw new Error("ZIP пошкоджений: розміри файлу в заголовках не збігаються.");
    const start = local + 30 + localNameLength + localExtraLength;
    checkRange(start, size);
    if (start + size > centralOffset) throw new Error("ZIP пошкоджений: дані файлу перекривають каталог.");
    entries.push({ path, directory, start, size, expanded, crc, method, local });
    position += 46 + nameLength + extraLength + commentLength;
  }
  if (position !== end) throw new Error("ZIP пошкоджений: зайві записи каталогу.");
  const byOffset = [...entries].sort((a, b) => a.local - b.local);
  for (let index = 1; index < byOffset.length; index++) {
    if (byOffset[index]!.local < byOffset[index - 1]!.start + byOffset[index - 1]!.size) throw new Error("ZIP пошкоджений: файли перекривають один одного.");
  }
  const result: Record<string, Uint8Array> = Object.create(null);
  for (const entry of entries) {
    if (Date.now() - began > limits.processingMs) throw new Error("Розпакування перевищило час. Зменште обсяг пакета.");
    const compressed = bytes.subarray(entry.start, entry.start + entry.size);
    let content: Uint8Array;
    try {
      content = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.expanded) });
    } catch { throw new Error(`Не вдалося безпечно розпакувати «${entry.path.slice(0, 160)}»: дані або заявлений розмір некоректні.`); }
    if (content.length !== entry.expanded || crc32(content) !== entry.crc) throw new Error(`ZIP пошкоджений: розмір або CRC файлу «${entry.path.slice(0, 160)}» не збігається.`);
    if (!entry.directory && !entry.path.startsWith("__MACOSX/") && !/(?:^|\/)\.DS_Store$/.test(entry.path)) result[entry.path] = content;
  }
  return result;
}
