import { describe, expect, it } from 'vitest'
import { exifDate, readExif } from '../src/photos/exif.js'

/**
 * What a photograph knows about itself.
 *
 * A site photograph with no timestamp is an illustration. The same photograph
 * with the moment it was taken and the point it was taken from is evidence,
 * and the difference decides claims.
 *
 * The bytes here are BUILT rather than committed as a fixture, because a
 * fixture proves the parser reads one file and this has to read what a phone
 * writes: both byte orders, a GPS block hanging off a pointer, a south-west
 * hemisphere, and a file that is simply broken.
 */

interface Entry {
  tag: number
  type: number
  count: number
  /** Inline value, or an offset into the extra block. */
  value: number
}

/** Builds a JPEG with exactly one APP1 EXIF segment and nothing else. */
function jpegWithExif(options: {
  little?: boolean
  ifd0?: Entry[]
  exif?: Entry[]
  gps?: Entry[]
  extra?: (write: (bytes: number[]) => number) => void
}): Uint8Array {
  const little = options.little ?? true
  const body: number[] = []
  const u16 = (n: number): number[] => (little ? [n & 0xff, (n >> 8) & 0xff] : [(n >> 8) & 0xff, n & 0xff])
  const u32 = (n: number): number[] =>
    little
      ? [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
      : [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]

  // TIFF header at offset 0 of the EXIF payload.
  body.push(...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8))

  const ifdSize = (entries: Entry[]): number => 2 + entries.length * 12 + 4
  const ifd0 = options.ifd0 ?? []
  const exif = options.exif ?? []
  const gps = options.gps ?? []

  const ifd0At = 8
  const exifAt = ifd0At + ifdSize(ifd0)
  const gpsAt = exifAt + ifdSize(exif)
  const extraAt = gpsAt + ifdSize(gps)

  const writeIfd = (entries: Entry[]): void => {
    body.push(...u16(entries.length))
    for (const entry of entries) {
      body.push(...u16(entry.tag), ...u16(entry.type), ...u32(entry.count), ...u32(entry.value))
    }
    body.push(...u32(0))
  }

  writeIfd(ifd0)
  writeIfd(exif)
  writeIfd(gps)

  options.extra?.((bytes) => {
    const at = 8 + (body.length - 8)
    body.push(...bytes)
    return at
  })

  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...body]
  const segment = [0xff, 0xe1, ...[(payload.length + 2) >> 8, (payload.length + 2) & 0xff], ...payload]
  // SOI, the APP1 segment, then a start-of-scan so the walker stops.
  return new Uint8Array([0xff, 0xd8, ...segment, 0xff, 0xda, 0x00, 0x02])
}

/** Offsets are easier to reason about when the layout is fixed up front. */
function build(options: { little?: boolean; south?: boolean; noGps?: boolean; taken?: string }): Uint8Array {
  const little = options.little ?? true
  const taken = options.taken ?? '2026:03:02 07:14:22'

  const extras: number[] = []
  const put = (bytes: number[]): number => {
    const at = extras.length
    extras.push(...bytes)
    return at
  }

  const asciiBytes = (s: string): number[] => [...s].map((c) => c.charCodeAt(0)).concat(0)
  const rational = (n: number, d: number): number[] => {
    const u32 = (v: number): number[] =>
      little
        ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]
        : [(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
    return [...u32(n), ...u32(d)]
  }

  const makeAt = put(asciiBytes('Apple'))
  const modelAt = put(asciiBytes('iPhone 17 Pro'))
  const takenAt = put(asciiBytes(taken))
  // 39° 44' 31.35" N, 104° 59' 29.51" W — a point in Denver.
  const latAt = put([...rational(39, 1), ...rational(44, 1), ...rational(3135, 100)])
  const lonAt = put([...rational(104, 1), ...rational(59, 1), ...rational(2951, 100)])
  const altAt = put(rational(161000, 100))
  // The hemisphere refs are two ASCII bytes, which fit in the entry's own
  // four value bytes, so EXIF stores them INLINE rather than by offset. An
  // earlier version of this builder wrote them to the extra block and
  // pointed at it, which produced a file no camera makes and made the parser
  // look wrong when it was right.
  const inlineAscii = (s: string): number => {
    const bytes = [...s].map((c) => c.charCodeAt(0)).concat(0, 0, 0, 0).slice(0, 4)
    return little
      ? bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)
      : (bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!
  }

  const ifd0: Entry[] = [
    { tag: 0x010f, type: 2, count: 6, value: 0 },
    { tag: 0x0110, type: 2, count: 14, value: 0 },
    { tag: 0x0112, type: 3, count: 1, value: 6 },
    { tag: 0x8769, type: 4, count: 1, value: 0 },
    ...(options.noGps ? [] : [{ tag: 0x8825, type: 4, count: 1, value: 0 }]),
  ]
  const exif: Entry[] = [
    { tag: 0x9003, type: 2, count: taken.length + 1, value: 0 },
    { tag: 0xa002, type: 4, count: 1, value: 4032 },
    { tag: 0xa003, type: 4, count: 1, value: 3024 },
  ]
  const gps: Entry[] = options.noGps
    ? []
    : [
        { tag: 0x0001, type: 2, count: 2, value: 0 },
        { tag: 0x0002, type: 5, count: 3, value: 0 },
        { tag: 0x0003, type: 2, count: 2, value: 0 },
        { tag: 0x0004, type: 5, count: 3, value: 0 },
        { tag: 0x0005, type: 1, count: 1, value: 0 },
        { tag: 0x0006, type: 5, count: 1, value: 0 },
      ]

  const ifdSize = (n: number): number => 2 + n * 12 + 4
  const ifd0At = 8
  const exifAt = ifd0At + ifdSize(ifd0.length)
  const gpsAt = exifAt + ifdSize(exif.length)
  const extraBase = gpsAt + ifdSize(gps.length)

  ifd0[0]!.value = extraBase + makeAt
  ifd0[1]!.value = extraBase + modelAt
  ifd0[3]!.value = exifAt
  if (!options.noGps) ifd0[4]!.value = gpsAt

  exif[0]!.value = extraBase + takenAt

  if (!options.noGps) {
    gps[0]!.value = inlineAscii(options.south ? 'S' : 'N')
    gps[1]!.value = extraBase + latAt
    gps[2]!.value = inlineAscii('W')
    gps[3]!.value = extraBase + lonAt
    gps[4]!.value = 0
    gps[5]!.value = extraBase + altAt
  }

  return jpegWithExif({ little, ifd0, exif, gps, extra: (write) => void write(extras) })
}

describe('reading a phone photograph', () => {
  it('reads when the shutter opened, to the second', () => {
    const meta = readExif(build({}))
    // No timezone. EXIF does not record one, and inventing UTC would shift
    // every photograph on a job by up to a day.
    expect(meta.takenAt).toBe('2026-03-02T07:14:22')
  })

  it('reads where it was taken from, in degrees', () => {
    const meta = readExif(build({}))
    expect(meta.latitude).toBeCloseTo(39.742042, 4)
    // West is negative. Getting the sign wrong puts a Denver job in China,
    // which is the kind of thing a map makes obvious and a number does not.
    expect(meta.longitude).toBeCloseTo(-104.991531, 4)
    expect(meta.altitude).toBeCloseTo(1610, 0)
  })

  it('handles the southern hemisphere', () => {
    expect(readExif(build({ south: true })).latitude).toBeCloseTo(-39.742042, 4)
  })

  it('reads a big-endian file the same way', () => {
    // Both byte orders are in the wild; a parser that assumes one reads the
    // other as garbage rather than failing, which is worse.
    const little = readExif(build({ little: true }))
    const big = readExif(build({ little: false }))
    expect(big.takenAt).toBe(little.takenAt)
    expect(big.latitude).toBeCloseTo(little.latitude!, 5)
    expect(big.make).toBe('Apple')
  })

  it('reads the camera and which way up it was held', () => {
    const meta = readExif(build({}))
    expect(meta.make).toBe('Apple')
    expect(meta.model).toBe('iPhone 17 Pro')
    // 6 is a phone held sideways, which is most site photographs.
    expect(meta.orientation).toBe(6)
    expect(meta.width).toBe(4032)
    expect(meta.height).toBe(3024)
  })

  it('reads a photograph with no GPS at all', () => {
    // A camera indoors, or a phone with location off. The timestamp is still
    // worth having and the photo still uploads.
    const meta = readExif(build({ noGps: true }))
    expect(meta.takenAt).toBe('2026-03-02T07:14:22')
    expect(meta.latitude).toBeNull()
    expect(meta.longitude).toBeNull()
  })
})

describe('what it refuses to invent', () => {
  it('returns nothing rather than throwing on a file that is not a JPEG', () => {
    expect(readExif(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toMatchObject({ takenAt: null, latitude: null })
  })

  it('survives a truncated segment', () => {
    // Losing the photo to save the metadata is the wrong trade every time.
    const full = build({})
    for (const cut of [10, 24, 60, full.length - 4]) {
      expect(() => readExif(full.slice(0, cut))).not.toThrow()
    }
  })

  it('refuses a camera with a dead battery', () => {
    // Zeros are what a camera writes when it has lost the clock, and
    // 0000-00-00 in a claim file is worse than no date at all.
    expect(exifDate('0000:00:00 00:00:00')).toBeNull()
    expect(readExif(build({ taken: '0000:00:00 00:00:00' })).takenAt).toBeNull()
  })

  it('parses the colon-separated date EXIF actually writes', () => {
    expect(exifDate('2026:03:02 07:14:22')).toBe('2026-03-02T07:14:22')
    expect(exifDate('2026-03-02T07:14:22')).toBe('2026-03-02T07:14:22')
    expect(exifDate('not a date')).toBeNull()
    expect(exifDate('')).toBeNull()
  })
})
