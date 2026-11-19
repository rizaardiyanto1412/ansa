export interface ZipEntry {
  name: string
  data: AsyncIterable<Uint8Array> | Iterable<Uint8Array>
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(crc: number, data: Uint8Array): number {
  let c = crc ^ 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const U32_MAX = 0xffffffff
const U16_MAX = 0xffff
// Bit 3: sizes follow the data, so an entry streams without being measured first. Bit 11: names are UTF-8.
const FLAGS = 0x0808

function record(size: number, fill: (view: DataView) => void, tail?: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(size + (tail?.length ?? 0))
  fill(new DataView(bytes.buffer))
  if (tail) bytes.set(tail, size)
  return bytes
}

function dosTime(at: Date): { time: number; date: number } {
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
    date: ((Math.max(1980, at.getUTCFullYear()) - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  }
}

// Stored, not compressed: an entry streams through without being held in memory. Only the index waits for the end.
export async function* zipStream(entries: AsyncIterable<ZipEntry>, at = new Date()): AsyncGenerator<Uint8Array> {
  const { time, date } = dosTime(at)
  const directory: Uint8Array[] = []
  let offset = 0
  let count = 0
  for await (const entry of entries) {
    const name = new TextEncoder().encode(entry.name)
    const start = offset
    const header = record(
      30,
      (v) => {
        v.setUint32(0, 0x04034b50, true)
        v.setUint16(4, 20, true)
        v.setUint16(6, FLAGS, true)
        v.setUint16(10, time, true)
        v.setUint16(12, date, true)
        v.setUint16(26, name.length, true)
      },
      name,
    )
    yield header
    offset += header.length
    let crc = 0
    let size = 0
    for await (const chunk of entry.data) {
      if (chunk.length === 0) continue
      crc = crc32(crc, chunk)
      size += chunk.length
      yield chunk
    }
    if (size >= U32_MAX) throw new Error(`${entry.name} is too large for the archive.`)
    offset += size
    const descriptor = record(16, (v) => {
      v.setUint32(0, 0x08074b50, true)
      v.setUint32(4, crc, true)
      v.setUint32(8, size, true)
      v.setUint32(12, size, true)
    })
    yield descriptor
    offset += descriptor.length
    const far = start >= U32_MAX
    directory.push(
      record(
        46,
        (v) => {
          v.setUint32(0, 0x02014b50, true)
          v.setUint16(4, far ? 45 : 20, true)
          v.setUint16(6, far ? 45 : 20, true)
          v.setUint16(8, FLAGS, true)
          v.setUint16(12, time, true)
          v.setUint16(14, date, true)
          v.setUint32(16, crc, true)
          v.setUint32(20, size, true)
          v.setUint32(24, size, true)
          v.setUint16(28, name.length, true)
          v.setUint16(30, far ? 12 : 0, true)
          v.setUint32(42, far ? U32_MAX : start, true)
        },
        far
          ? new Uint8Array([
              ...name,
              ...record(12, (v) => {
                v.setUint16(0, 0x0001, true)
                v.setUint16(2, 8, true)
                v.setBigUint64(4, BigInt(start), true)
              }),
            ])
          : name,
      ),
    )
    count++
  }

  const directoryStart = offset
  let directorySize = 0
  for (const part of directory) {
    yield part
    directorySize += part.length
  }
  const zip64 = count > U16_MAX || directoryStart >= U32_MAX || directorySize >= U32_MAX
  if (zip64) {
    yield record(56, (v) => {
      v.setUint32(0, 0x06064b50, true)
      v.setBigUint64(4, 44n, true)
      v.setUint16(12, 45, true)
      v.setUint16(14, 45, true)
      v.setBigUint64(24, BigInt(count), true)
      v.setBigUint64(32, BigInt(count), true)
      v.setBigUint64(40, BigInt(directorySize), true)
      v.setBigUint64(48, BigInt(directoryStart), true)
    })
    yield record(20, (v) => {
      v.setUint32(0, 0x07064b50, true)
      v.setBigUint64(8, BigInt(directoryStart + directorySize), true)
      v.setUint32(16, 1, true)
    })
  }
  yield record(22, (v) => {
    v.setUint32(0, 0x06054b50, true)
    v.setUint16(8, Math.min(count, U16_MAX), true)
    v.setUint16(10, Math.min(count, U16_MAX), true)
    v.setUint32(12, Math.min(directorySize, U32_MAX), true)
    v.setUint32(16, Math.min(directoryStart, U32_MAX), true)
  })
}
