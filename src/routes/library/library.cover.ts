import { createHash } from 'node:crypto'
import { del, put } from '@vercel/blob'
import sharp from 'sharp'

export const OPEN_LIBRARY_COVERS_HOST = 'covers.openlibrary.org'
const BLOB_HOST_SUFFIX = '.public.blob.vercel-storage.com'
/** wide enough for the biggest cover the library draws, on a 2x screen */
const COVER_WIDTH = 600
const YEAR = 365 * 24 * 60 * 60

export type Cover = { coverUrl: string; coverColor: string }

/** the cover is sampled at this size, enough to tell its colours apart */
const SAMPLE = { width: 40, height: 60 }
/** how far apart a colour's channels must be to count as a colour, not a grey */
const MIN_CHROMA = 48
/** the share of a cover that has to be colourful for a colour to win over its greys */
const MIN_COLOURFUL = 0.2

const hex = (value: number) => Math.round(value).toString(16).padStart(2, '0')

/**
 * The colour the cover reads as from across the room: its most common colour,
 * averaged within an 8×8×8 bucket so it stays true. White borders, black
 * lettering and shadows lose to the colours of the picture, unless the cover
 * is hardly colourful at all and its grey is what it is.
 *
 * (sharp's own `dominant` counts the greys too, so a red cover with a black
 * title band comes out black.)
 */
export async function coverColor(image: Buffer): Promise<string> {
  const data = await sharp(image)
    .resize({ ...SAMPLE, fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer()

  const buckets = new Map<number, { count: number; sums: number[] }>()
  for (const [at, value] of data.entries()) {
    const pixel = at - (at % 3)
    const key =
      (data.readUInt8(pixel) >> 5) * 64 +
      (data.readUInt8(pixel + 1) >> 5) * 8 +
      (data.readUInt8(pixel + 2) >> 5)
    let bucket = buckets.get(key)
    if (!bucket) buckets.set(key, (bucket = { count: 0, sums: [0, 0, 0] }))
    if (at === pixel) bucket.count++
    bucket.sums[at % 3] = (bucket.sums[at % 3] ?? 0) + value
  }

  const colours = [...buckets.values()].map(({ count, sums }) => {
    const mean = sums.map((sum) => sum / count)
    const colourful = Math.max(...mean) - Math.min(...mean) >= MIN_CHROMA
    return { count, mean, colourful }
  })
  const colourful = colours.filter((colour) => colour.colourful)
  const share =
    colourful.reduce((sum, { count }) => sum + count, 0) / (data.length / 3)

  const [top] = (share >= MIN_COLOURFUL ? colourful : colours).sort(
    (a, b) => b.count - a.count,
  )
  return `#${(top?.mean ?? [0, 0, 0]).map(hex).join('')}`
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/** Whether the cover already lives in our Blob store rather than on Open Library. */
export const isMirrored = (url: string) =>
  !!hostOf(url)?.endsWith(BLOB_HOST_SUFFIX)

export const isOpenLibraryCover = (url: string) =>
  hostOf(url) === OPEN_LIBRARY_COVERS_HOST

/**
 * Shrinks the image to a WebP cover, works out its dominant colour and puts it
 * in Blob under a name that changes with its content, so it can be cached for good.
 */
export async function storeCover(
  token: string,
  bookId: string,
  image: Buffer,
): Promise<Cover> {
  const webp = await sharp(image)
    // phone photos come sideways without their EXIF turn
    .rotate()
    .resize({ width: COVER_WIDTH, withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer()

  const hash = createHash('sha256').update(webp).digest('hex').slice(0, 12)

  const blob = await put(`library/covers/${bookId}-${hash}.webp`, webp, {
    access: 'public',
    contentType: 'image/webp',
    cacheControlMaxAge: YEAR,
    // the same image again lands on the same name
    allowOverwrite: true,
    token,
  })

  return {
    coverUrl: blob.url,
    coverColor: await coverColor(webp),
  }
}

/**
 * Copies an Open Library cover into Blob, in its large size, or returns null
 * when it has none, can't be reached or there is no Blob store to put it in.
 */
export async function mirrorCover(
  token: string | undefined,
  bookId: string,
  url: string,
): Promise<Cover | null> {
  if (!token || !isOpenLibraryCover(url)) return null

  try {
    const large = new URL(url.replace(/-[SM]\.jpg$/, '-L.jpg'))
    // a 404 instead of a blank pixel when Open Library has no such cover
    large.searchParams.set('default', 'false')

    const response = await fetch(large, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) return null

    return await storeCover(
      token,
      bookId,
      Buffer.from(await response.arrayBuffer()),
    )
  } catch {
    return null
  }
}

/** Removes a replaced cover from Blob; one still on Open Library is left alone. */
export async function deleteCover(
  token: string | undefined,
  url: string | null,
): Promise<void> {
  if (!token || !url || !isMirrored(url)) return
  try {
    await del(url, { token })
  } catch {
    // an orphaned blob costs a few kilobytes, not a failed request
  }
}
