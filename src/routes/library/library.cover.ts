import { createHash } from 'node:crypto'
import { del, put } from '@vercel/blob'
import sharp from 'sharp'

export const OPEN_LIBRARY_COVERS_HOST = 'covers.openlibrary.org'
const BLOB_HOST_SUFFIX = '.public.blob.vercel-storage.com'
/** wide enough for the biggest cover the library draws, on a 2x screen */
const COVER_WIDTH = 600
const YEAR = 365 * 24 * 60 * 60

export type Cover = { coverUrl: string; coverColor: string }

const hex = (value: number) => value.toString(16).padStart(2, '0')

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

  const { dominant } = await sharp(webp).stats()
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
    coverColor: `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`,
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
