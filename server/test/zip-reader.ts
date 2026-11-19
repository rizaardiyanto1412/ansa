import assert from 'node:assert/strict'
import zlib from 'node:zlib'

export interface ZipFile {
  name: string
  data: Buffer
}

export function readZip(archive: Uint8Array): ZipFile[] {
  const zip = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength)
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(end >= 0, 'the archive ends with a directory record')
  const count = zip.readUInt16LE(end + 10)
  let at = zip.readUInt32LE(end + 16)
  const files: ZipFile[] = []
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50, `directory entry ${i} starts with its signature`)
    const crc = zip.readUInt32LE(at + 16)
    const size = zip.readUInt32LE(at + 24)
    const nameLength = zip.readUInt16LE(at + 28)
    const extraLength = zip.readUInt16LE(at + 30)
    const header = zip.readUInt32LE(at + 42)
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength)
    assert.equal(zip.readUInt32LE(header), 0x04034b50, `${name} has a local header`)
    const start = header + 30 + zip.readUInt16LE(header + 26) + zip.readUInt16LE(header + 28)
    const data = zip.subarray(start, start + size)
    assert.equal(zlib.crc32(data), crc, `${name} matches its checksum`)
    files.push({ name, data })
    at += 46 + nameLength + extraLength + zip.readUInt16LE(at + 32)
  }
  return files
}
