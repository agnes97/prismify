import { createHash } from 'node:crypto'
import { del, put } from '@vercel/blob'
import sharp from 'sharp'

export const OPEN_LIBRARY_COVERS_HOST = 'covers.openlibrary.org'
const BLOB_HOST_SUFFIX = '.public.blob.vercel-storage.com'
/** wide enough for the biggest cover the library draws, on a 2x screen */
const COVER_WIDTH = 600
/** tall enough for the tallest spine the library draws, on a 2x screen */
const SPINE_HEIGHT = 640
const YEAR = 365 * 24 * 60 * 60

export type Cover = { coverUrl: string; coverColor: string }
export type Spine = {
  spineUrl: string
  spineColor: string
  spineRatio: number
}

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
 * Shrinks the image to WebP and puts it in Blob, in `folder`, under a name
 * that changes with its content, so it can be cached for good. Returns the
 * image and its URL.
 */
async function storeImage(
  token: string,
  folder: 'covers' | 'spines',
  bookId: string,
  image: Buffer,
  size: sharp.ResizeOptions,
): Promise<{ webp: Buffer; url: string }> {
  const webp = await sharp(image)
    // phone photos come sideways without their EXIF turn
    .rotate()
    .resize({ ...size, withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer()

  const hash = createHash('sha256').update(webp).digest('hex').slice(0, 12)

  const blob = await put(`library/${folder}/${bookId}-${hash}.webp`, webp, {
    access: 'public',
    contentType: 'image/webp',
    cacheControlMaxAge: YEAR,
    // the same image again lands on the same name
    allowOverwrite: true,
    token,
  })

  return { webp, url: blob.url }
}

/** Stores the image as the book's cover, with its colour for the spine. */
export async function storeCover(
  token: string,
  bookId: string,
  image: Buffer,
): Promise<Cover> {
  const { webp, url } = await storeImage(token, 'covers', bookId, image, {
    width: COVER_WIDTH,
  })
  return { coverUrl: url, coverColor: await coverColor(webp) }
}

/**
 * Stores a photo of the book's real spine, cropped and stood upright by the
 * library, with its colour for the cloth around it.
 */
export async function storeSpine(
  token: string,
  bookId: string,
  image: Buffer,
): Promise<Spine> {
  const { webp, url } = await storeImage(token, 'spines', bookId, image, {
    height: SPINE_HEIGHT,
  })
  const { width = 1, height = 1 } = await sharp(webp).metadata()
  return {
    spineUrl: url,
    spineColor: await coverColor(webp),
    spineRatio: Math.round((width / height) * 1000) / 1000,
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

/** Removes a replaced cover or spine from Blob; one still on Open Library is left alone. */
export async function deleteImage(
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
