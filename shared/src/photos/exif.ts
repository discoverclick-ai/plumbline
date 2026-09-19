/**
 * Reading what a photograph knows about itself.
 *
 * A site photograph with no timestamp is an illustration. The same
 * photograph with the moment it was taken and the point it was taken from is
 * evidence, and the difference decides claims. Phones record both, cameras
 * record the first, and almost every construction product throws them away by
 * re-encoding on upload.
 *
 * So this reads the original bytes and never modifies them. Deterministic, no
 * dependencies, and it reads only what matters: when, where, and which way
 * up. Everything else in an EXIF block is for photographers.
 *
 * Deliberately tolerant. A truncated or unusual APP1 segment returns nulls
 * rather than throwing, because a foreman's photograph must upload whether or
 * not its metadata parses, and losing the photo to save the metadata is the
 * wrong trade every time.
 */

export interface PhotoMetadata {
  /** When the shutter opened, in the camera's own local time, as written. */
  takenAt: string | null
  latitude: number | null
  longitude: number | null
  /** Metres, which on a construction site is also roughly floor height. */
  altitude: number | null
  /** 1-8 as EXIF numbers them; 6 and 8 are a phone held sideways. */
  orientation: number | null
  make: string | null
  model: string | null
  width: number | null
  height: number | null
}

export const NO_METADATA: PhotoMetadata = {
  takenAt: null,
  latitude: null,
  longitude: null,
  altitude: null,
  orientation: null,
  make: null,
  model: null,
  width: null,
  height: null,
}

const TAG_MAKE = 0x010f
const TAG_MODEL = 0x0110
const TAG_ORIENTATION = 0x0112
const TAG_EXIF_IFD = 0x8769
const TAG_GPS_IFD = 0x8825
const TAG_DATETIME_ORIGINAL = 0x9003
const TAG_DATETIME_DIGITIZED = 0x9004
const TAG_PIXEL_X = 0xa002
const TAG_PIXEL_Y = 0xa003

const GPS_LAT_REF = 0x0001
const GPS_LAT = 0x0002
const GPS_LON_REF = 0x0003
const GPS_LON = 0x0004
const GPS_ALT_REF = 0x0005
const GPS_ALT = 0x0006

export function readExif(bytes: Uint8Array): PhotoMetadata {
  try {
    return parse(bytes)
  } catch {
    // A photograph that uploads with no metadata beats a photograph that does
    // not upload. This is the whole reason the parser is tolerant.
    return { ...NO_METADATA }
  }
}

function parse(bytes: Uint8Array): PhotoMetadata {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return { ...NO_METADATA } // Not a JPEG.

  let offset = 2
  let exifStart = -1
  while (offset + 4 <= bytes.length) {
    if (view.getUint8(offset) !== 0xff) break
    const marker = view.getUint8(offset + 1)
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    // Start of scan: the image data begins and there is no more metadata.
    if (marker === 0xda) break

    const length = view.getUint16(offset + 2)
    if (marker === 0xe1 && offset + 10 <= bytes.length) {
      const header = String.fromCharCode(...bytes.slice(offset + 4, offset + 8))
      if (header === 'Exif') {
        exifStart = offset + 10
        break
      }
    }
    if (length < 2) break
    offset += 2 + length
  }

  if (exifStart < 0 || exifStart + 8 > bytes.length) return { ...NO_METADATA }

  // The TIFF header inside says which byte order everything after it uses.
  const byteOrder = view.getUint16(exifStart)
  const little = byteOrder === 0x4949
  if (!little && byteOrder !== 0x4d4d) return { ...NO_METADATA }

  const u16 = (at: number): number => view.getUint16(at, little)
  const u32 = (at: number): number => view.getUint32(at, little)

  const ifd0 = exifStart + u32(exifStart + 4)
  const out: PhotoMetadata = { ...NO_METADATA }

  const readIfd = (
    start: number,
    handler: (tag: number, type: number, count: number, valueAt: number) => void,
  ): void => {
    if (start + 2 > bytes.length) return
    const entries = u16(start)
    // A corrupt count would walk off the end; cap it at what the buffer can
    // hold rather than trusting the file.
    const max = Math.min(entries, Math.floor((bytes.length - start - 2) / 12))
    for (let i = 0; i < max; i += 1) {
      const entry = start + 2 + i * 12
      const tag = u16(entry)
      const type = u16(entry + 2)
      const count = u32(entry + 4)
      const size = typeSize(type) * count
      const valueAt = size <= 4 ? entry + 8 : exifStart + u32(entry + 8)
      if (valueAt < 0 || valueAt + Math.min(size, 8) > bytes.length) continue
      handler(tag, type, count, valueAt)
    }
  }

  const ascii = (at: number, count: number): string =>
    String.fromCharCode(...bytes.slice(at, at + Math.max(0, count - 1)))
      .replace(/\0.*$/, '')
      .trim()

  const rational = (at: number): number => {
    const numerator = u32(at)
    const denominator = u32(at + 4)
    return denominator === 0 ? 0 : numerator / denominator
  }

  let exifIfd = -1
  let gpsIfd = -1

  readIfd(ifd0, (tag, type, count, valueAt) => {
    if (tag === TAG_MAKE && type === 2) out.make = ascii(valueAt, count) || null
    else if (tag === TAG_MODEL && type === 2) out.model = ascii(valueAt, count) || null
    else if (tag === TAG_ORIENTATION) out.orientation = u16(valueAt)
    else if (tag === TAG_EXIF_IFD) exifIfd = exifStart + u32(valueAt)
    else if (tag === TAG_GPS_IFD) gpsIfd = exifStart + u32(valueAt)
  })

  if (exifIfd > 0) {
    readIfd(exifIfd, (tag, type, count, valueAt) => {
      // DateTimeOriginal is when the shutter opened. DateTimeDigitized is
      // when it was written to the card; they differ on a scanned print, so
      // the second is a fallback rather than an equal.
      if (tag === TAG_DATETIME_ORIGINAL && type === 2) out.takenAt = exifDate(ascii(valueAt, count))
      else if (tag === TAG_DATETIME_DIGITIZED && type === 2 && !out.takenAt) {
        out.takenAt = exifDate(ascii(valueAt, count))
      } else if (tag === TAG_PIXEL_X) out.width = type === 3 ? u16(valueAt) : u32(valueAt)
      else if (tag === TAG_PIXEL_Y) out.height = type === 3 ? u16(valueAt) : u32(valueAt)
    })
  }

  if (gpsIfd > 0) {
    let latRef = 'N'
    let lonRef = 'E'
    let lat: number | null = null
    let lon: number | null = null
    let altRef = 0

    readIfd(gpsIfd, (tag, type, count, valueAt) => {
      if (tag === GPS_LAT_REF && type === 2) latRef = ascii(valueAt, count) || 'N'
      else if (tag === GPS_LON_REF && type === 2) lonRef = ascii(valueAt, count) || 'E'
      else if (tag === GPS_LAT && count === 3) {
        lat = dms(rational(valueAt), rational(valueAt + 8), rational(valueAt + 16))
      } else if (tag === GPS_LON && count === 3) {
        lon = dms(rational(valueAt), rational(valueAt + 8), rational(valueAt + 16))
      } else if (tag === GPS_ALT_REF) altRef = view.getUint8(valueAt)
      else if (tag === GPS_ALT) out.altitude = round(rational(valueAt), 2)
    })

    if (lat !== null) out.latitude = round(latRef === 'S' ? -lat : lat, 6)
    if (lon !== null) out.longitude = round(lonRef === 'W' ? -lon : lon, 6)
    // Reference 1 means below sea level, which on a job is a basement.
    if (out.altitude !== null && altRef === 1) out.altitude = -out.altitude
  }

  return out
}

function typeSize(type: number): number {
  switch (type) {
    case 1:
    case 2:
    case 6:
    case 7:
      return 1
    case 3:
    case 8:
      return 2
    case 4:
    case 9:
    case 11:
      return 4
    case 5:
    case 10:
    case 12:
      return 8
    default:
      return 1
  }
}

function dms(degrees: number, minutes: number, seconds: number): number {
  return degrees + minutes / 60 + seconds / 3600
}

function round(value: number, places: number): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

/**
 * EXIF writes dates as "2026:03:02 07:14:22", with colons in the date.
 *
 * Kept as a local timestamp with no zone, because EXIF does not record one
 * and inventing UTC would shift every photograph on a job by up to a day. The
 * project's own timezone is what turns this into an instant, and that lives
 * on the calendar rather than here.
 */
export function exifDate(value: string): string | null {
  // Colons are what the standard says and what phones write; a handful of
  // cameras and every re-encoder write dashes instead. Both, rather than
  // discarding a real timestamp over a separator.
  const match = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim())
  if (!match) return null
  const [, y, mo, d, h, mi, s] = match
  // A camera with a dead battery writes zeros, and a date of 0000-00-00 in a
  // claim file is worse than no date at all.
  if (y === '0000' || mo === '00' || d === '00') return null
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`
}
