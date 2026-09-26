import { execFileSync } from 'node:child_process';

/**
 * 生成一个最小的 zip（stored，不压缩）。
 *
 * 为什么不直接调 `zip` 命令：安装 skill 只需要 `unzip`，测试再额外依赖一个
 * `zip` 二进制会让「能跑测试」变成「装了两个命令行工具」。stored 条目是完全
 * 合法的 zip，`unzip` 处理起来和压缩条目没有区别。
 */

export interface ZipEntry {
  path: string;
  content: string;
  /**
   * Unix mode（含类型位）。省略 = 普通文件 `0o644`。
   *
   * 需要它才能造出**符号链接条目**：zip 里没有独立的「这是链接」标记，
   * 链接是靠 central directory 的 external attributes 高位上的 `S_IFLNK`
   * 表达的，内容则是链接目标路径。没有这个字段就测不了「拒绝 symlink」。
   */
  mode?: number;
}

/** `version made by` 的 UNIX 标记（高字节 3 = Unix，低字节是版本号 30）。 */
const MADE_BY_UNIX = 0x031e;
const MODE_FILE = 0o644;

/** 一个指向 `target` 的符号链接条目（`S_IFLNK | 0777`）。 */
export const SYMLINK_MODE = 0o120777;

/** 标准 CRC-32（IEEE 802.3），表和 zip 规范附录里的那张一致。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 固定时间戳：产出的字节流稳定，失败时 diff 才有意义。 */
const DOS_TIME = 0;
const DOS_DATE = (2026 - 1980) * 512 + 1 * 32 + 1;

export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const data = Buffer.from(entry.content, 'utf8');
    const sum = crc32(data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    // UNIX 才能让 unzip 按 external attributes 还原权限 / 符号链接
    central.writeUInt16LE(MADE_BY_UNIX, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((entry.mode ?? MODE_FILE) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, end]);
}

/** 本机有没有 unzip —— 安装 skill 的真前置条件。 */
export function hasUnzip(): boolean {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
