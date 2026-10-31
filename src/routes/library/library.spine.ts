import { lookup } from 'node:dns'
import type { IncomingMessage } from 'node:http'
import { request } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import type { FastifyBaseLogger } from 'fastify'
import type OpenAI from 'openai'
import sharp from 'sharp'
import { z } from 'zod'

import { OPENAI_IMAGE_MODEL, OPENAI_TEXT_MODEL } from '../ai/ai.helper.js'

/** the book as the spine is looked for and drawn after */
export type SpineBook = {
  title: string
  authors: string[]
  year: number | null
  isbn: string | null
  series: string | null
  seriesNumber: number | null
  pages: number | null
}

/** another volume of the book's series, whose spine the drawing follows */
export type SeriesSpine = {
  seriesNumber: number | null
  spine: Buffer
}

/** a photo image search found of the book, for the reader to crop its spine out of */
export type SpineCandidate = {
  /** the photo on the web */
  imageUrl: string
  /** the page it was found on */
  pageUrl: string
  /** the image search's own small copy, which shows where the photo's site won't */
  preview: string
  /** the title of the page it was found on */
  title: string
}

/** how many photos each image search brings back, the most of them it ranks well */
const IMAGE_SEARCH_COUNT = 50
/** a found photo bigger than this isn't a photo of a book */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** a found photo is shrunk to this to crop the spine out of, which is plenty to read it */
const PHOTO_SIDE = 2048
/** the drawn spine is kept this tall; the shelf stores it at half */
const DRAWN_HEIGHT = 1280

const describe = ({
  title,
  authors,
  year,
  isbn,
  series,
  seriesNumber,
}: SpineBook) =>
  [
    `"${title}"`,
    authors.length > 0 && `by ${authors.join(', ')}`,
    year && `(${year})`,
    isbn && `ISBN ${isbn}`,
    series &&
      `${seriesNumber === null ? 'a volume' : `volume ${seriesNumber}`} of the series "${series}"`,
  ]
    .filter(Boolean)
    .join(' ')

/**
 * How the spine of a book this long measures, width to height: 0.07 mm a page
 * and 2 mm of boards, on a book 20 cm tall, no thicker past 1000 pages, as the
 * library's shelves measure it.
 */
const spineShape = (pages: number) => {
  const width = Math.min(pages, 1000) * 0.07 + 2
  return `It has ${pages} pages, so its spine is about ${Math.round(width)} mm wide and 200 mm tall, 1 : ${Math.round((200 / width) * 10) / 10} (width : height); draw it in that proportion.`
}

const dataUrl = (jpeg: Buffer) =>
  `data:image/jpeg;base64,${jpeg.toString('base64')}`

/** how much of the cover's width along each side is sampled for the colour the spine joins */
const EDGE_SHARE = 0.04

const hex = (value: number) => Math.round(value).toString(16).padStart(2, '0')

/**
 * The colour along each side of the cover, where the spine joins it: the most
 * common one in a narrow strip, averaged within a 16×16×16 bucket so it stays
 * true. A white cover reads white here, however the photo of its spine is lit.
 */
async function coverEdges(
  cover: Buffer,
): Promise<{ left: string; right: string }> {
  const upright = await sharp(cover)
    .rotate()
    .removeAlpha()
    .toBuffer({ resolveWithObject: true })
  const { width, height } = upright.info
  const strip = Math.max(1, Math.round(width * EDGE_SHARE))

  const edge = async (left: number) => {
    const data = await sharp(upright.data)
      .extract({ left, top: 0, width: strip, height })
      .resize({ width: 4, height: 64, fit: 'fill' })
      .raw()
      .toBuffer()
    const buckets = new Map<number, { count: number; sums: number[] }>()
    for (let pixel = 0; pixel < data.length; pixel += 3) {
      const rgb = [0, 1, 2].map((channel) => data.readUInt8(pixel + channel))
      const key = rgb.reduce((key, value) => key * 16 + (value >> 4), 0)
      const bucket = buckets.get(key) ?? { count: 0, sums: [0, 0, 0] }
      buckets.set(key, {
        count: bucket.count + 1,
        sums: bucket.sums.map((sum, channel) => sum + (rgb[channel] ?? 0)),
      })
    }
    const [top = { count: 1, sums: [0, 0, 0] }] = [...buckets.values()].sort(
      (a, b) => b.count - a.count,
    )
    return `#${top.sums.map((sum) => hex(sum / top.count)).join('')}`
  }

  return { left: await edge(0), right: await edge(width - strip) }
}

/** Turns any image upright and shrinks it to a JPEG no longer than `side`. */
const shrink = (image: Buffer, side: number) =>
  sharp(image)
    .rotate()
    .resize({
      width: side,
      height: side,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 85 })
    .toBuffer()

/** addresses inside networks, which a photo URL from the web must never reach */
const PRIVATE = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  // the NAT64 prefix can hide any IPv4 address; IPv4 written as IPv6
  // (::ffff:…) is already checked against the IPv4 networks by BlockList
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv6')
}

const isPrivate = (address: string, family: number | string) =>
  PRIVATE.check(address, family === 6 || family === 'IPv6' ? 'ipv6' : 'ipv4')

/**
 * Resolves a host as `dns.lookup` does, but refuses one that points inside a
 * network. It runs as the socket connects, so a name can't pass a check and
 * then resolve elsewhere.
 */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, '', 4)
      return
    }

    const usable = addresses.filter(
      ({ address, family }) => !isPrivate(address, family),
    )
    const [first] = usable
    if (!first || usable.length < addresses.length) {
      callback(
        Object.assign(new Error(`${hostname} is not on the public web`), {
          code: 'EPRIVATE',
        }),
        '',
        4,
      )
      return
    }
    if (options.all) {
      callback(null, usable)
      return
    }
    callback(null, first.address, first.family)
  })
}

/** A URL a photo may be fetched from: https, by a host name, not an address. */
function publicUrl(url: string): URL | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  return parsed.protocol === 'https:' &&
    isIP(host) === 0 &&
    host !== 'localhost' &&
    host.includes('.')
    ? parsed
    : null
}

type Fetched =
  | { kind: 'image'; image: Buffer }
  | { kind: 'redirect'; location: string }
  | { kind: 'failed' }

/** The body, or failed once it grows past `MAX_IMAGE_BYTES`. */
async function readCapped(response: IncomingMessage): Promise<Fetched> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of response) {
      const part = Buffer.from(chunk as Uint8Array)
      size += part.length
      if (size > MAX_IMAGE_BYTES) {
        response.destroy()
        return { kind: 'failed' }
      }
      chunks.push(part)
    }
  } catch {
    return { kind: 'failed' }
  }
  return { kind: 'image', image: Buffer.concat(chunks) }
}

/** One GET, without following redirects, that gives up past `MAX_IMAGE_BYTES`. */
function getOnce(url: URL): Promise<Fetched> {
  return new Promise((resolve) => {
    const call = request(
      url,
      {
        lookup: publicLookup,
        // the whole download, so a server dribbling bytes can't hold it open
        signal: AbortSignal.timeout(10_000),
        // some shops turn away requests that don't look like a browser
        headers: { 'User-Agent': 'Mozilla/5.0 (library spine finder)' },
      },
      (response: IncomingMessage) => {
        const status = response.statusCode ?? 0
        const { location } = response.headers
        if (status >= 300 && status < 400 && location) {
          response.resume()
          resolve({ kind: 'redirect', location })
          return
        }

        const type = response.headers['content-type'] ?? ''
        const length = Number(response.headers['content-length'] ?? 0)
        if (
          status !== 200 ||
          !type.startsWith('image/') ||
          length > MAX_IMAGE_BYTES
        ) {
          response.resume()
          resolve({ kind: 'failed' })
          return
        }

        resolve(readCapped(response))
      },
    )
    call.on('error', () => {
      resolve({ kind: 'failed' })
    })
    call.end()
  })
}

/** how many redirects a photo URL may take, each checked again */
const MAX_REDIRECTS = 3

/**
 * Downloads an image from the open web, or null when it isn't one. Only public
 * https hosts by name are fetched, on every redirect, and never an address
 * inside a network, whatever the name resolves to.
 */
export async function fetchImage(url: string): Promise<Buffer | null> {
  let next = publicUrl(url)
  for (let hop = 0; next && hop <= MAX_REDIRECTS; hop++) {
    const fetched = await getOnce(next)
    if (fetched.kind === 'image') return fetched.image
    if (fetched.kind === 'failed') return null
    next = publicUrl(new URL(fetched.location, next).href)
  }
  return null
}

/** Shrinks a photo from the web to crop the spine out of, or null when it can't be fetched. */
export async function webPhoto(url: string): Promise<Buffer | null> {
  const image = await fetchImage(url)
  if (!image) return null
  try {
    return await shrink(image, PHOTO_SIDE)
  } catch {
    return null
  }
}

const imageSearchSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().optional(),
      // the page the photo is on
      url: z.string(),
      thumbnail: z.object({ src: z.string() }).optional(),
      properties: z.object({ url: z.string() }).optional(),
    }),
  ),
})

/**
 * Finding and drawing a spine take longer than a Vercel function may run, so
 * each runs at OpenAI in the background as a response the library polls for,
 * by its id. Only the reader's own key can read it. Its metadata says which
 * step it is.
 */
export type SpineJob =
  | {
      status: 'working'
      job: string
      /** which step is running, so the reader can be told */
      step: Step
      /** still waiting its turn at OpenAI */
      queued: boolean
    }
  | { status: 'done'; image: string }

type Step = 'drawing'

/** A step that ran but came to nothing, with what to tell the reader. */
export class SpineJobError extends Error {}

const working = (job: string, step: Step, queued = true): SpineJob => ({
  status: 'working',
  job,
  step,
  queued,
})

/**
 * What a book is looked up by in image search, round by round, each searching
 * again finding photos the earlier ones may not have: first the book itself,
 * as shops show it in 3D or from the side, its spine, and the box set a series
 * comes in; then its bindings and shelves of it; then its ISBN, edition and
 * the series' volumes side by side.
 */
function imageQueries(
  { title, authors, year, isbn, series, seriesNumber }: SpineBook,
  round: number,
): string[] {
  const author = authors[0] ?? ''
  const rounds = [
    [
      `${title} ${author} book`,
      `${title} ${author} book spine`,
      series && `${series} ${author} box set`,
    ],
    [
      `${title} ${author} hardcover`,
      `${title} ${author} paperback`,
      `${title} ${author} bookshelf`,
    ],
    [
      isbn,
      year && `${title} ${author} ${year} edition`,
      series && `${series} ${seriesNumber ?? ''} ${author} books spines`,
    ],
  ]
  return (rounds[round] ?? [])
    .filter((query): query is string => Boolean(query))
    .map((query) => query.replace(/\s+/g, ' ').trim())
}

/** The photos Brave's image search finds for one query, as it ranks them. */
async function searchImages(
  key: string,
  query: string,
): Promise<SpineCandidate[]> {
  const url = new URL('https://api.search.brave.com/res/v1/images/search')
  url.search = new URLSearchParams({
    q: query,
    count: String(IMAGE_SEARCH_COUNT),
    safesearch: 'strict',
  }).toString()
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new SpineJobError(`The image search failed (${response.status})`)
  }

  const { results } = imageSearchSchema.parse(await response.json())
  return results.flatMap(({ title, url: pageUrl, properties, thumbnail }) => {
    const imageUrl = properties?.url ?? thumbnail?.src
    return imageUrl
      ? [
          {
            imageUrl,
            pageUrl,
            preview: thumbnail?.src ?? imageUrl,
            title: title ?? '',
          },
        ]
      : []
  })
}

/**
 * eBay photos are found as small thumbnails, e.g. …/s-l140.webp, too small to
 * read a spine from; the same photo is served large as …/s-l1600.webp.
 */
const largest = (imageUrl: string) =>
  /^https:\/\/i\.ebayimg\.com\//.test(imageUrl)
    ? imageUrl.replace(/\/s-l\d+\./, '/s-l1600.')
    : imageUrl

/**
 * What a book's cover is looked up by in image search, round by round as for
 * its spine: first the cover itself and by its ISBN; then its bindings; then
 * its edition and the ebook, whose cover shops show flat.
 */
function coverQueries(
  { title, authors, year, isbn }: SpineBook,
  round: number,
): string[] {
  const author = authors[0] ?? ''
  const rounds = [
    [`${title} ${author} book cover`, isbn && `${isbn} cover`],
    [`${title} ${author} hardcover`, `${title} ${author} paperback`],
    [
      year && `${title} ${author} ${year} edition cover`,
      `${title} ${author} ebook`,
    ],
  ]
  return (rounds[round] ?? [])
    .filter((query): query is string => Boolean(query))
    .map((query) => query.replace(/\s+/g, ' ').trim())
}

/**
 * Every photo image search finds for a `round` of the queries, the queries'
 * best taken in turn, each once; and whether a further round would look again.
 */
async function findPhotos(
  key: string,
  queriesFor: (round: number) => string[],
  round: number,
): Promise<{ candidates: SpineCandidate[]; more: boolean }> {
  const queries = queriesFor(round)
  const more = queriesFor(round + 1).length > 0
  if (queries.length === 0) return { candidates: [], more }

  const searched = await Promise.allSettled(
    queries.map((query) => searchImages(key, query)),
  )
  const lists = searched.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  )
  if (lists.length === 0) {
    throw new SpineJobError('The image search failed, try again')
  }

  const found = new Map<string, SpineCandidate>()
  const longest = Math.max(...lists.map((list) => list.length))
  for (let rank = 0; rank < longest; rank++) {
    for (const photo of lists.flatMap((list) => list[rank] ?? [])) {
      const imageUrl = largest(photo.imageUrl)
      if (!found.has(imageUrl)) found.set(imageUrl, { ...photo, imageUrl })
    }
  }
  return { candidates: [...found.values()], more }
}

/**
 * Every photo image search finds of the book in a `round` of searching, for
 * the reader to pick the one that shows its spine.
 */
export function findSpinePhotos(key: string, book: SpineBook, round = 0) {
  return findPhotos(key, (at) => imageQueries(book, at), round)
}

/**
 * Every photo image search finds of the book's cover in a `round` of
 * searching, for the reader to pick and crop it out of.
 */
export function findCoverPhotos(key: string, book: SpineBook, round = 0) {
  return findPhotos(key, (at) => coverQueries(book, at), round)
}

/**
 * Starts ChatGPT painting the book's spine straight on and sharp, after a photo
 * that shows it (`reference`), the cover it has to join, and the spines of
 * other volumes in its series it should look like.
 */
export async function startSpineDrawing(
  openai: OpenAI,
  bookId: string,
  book: SpineBook,
  reference: Buffer,
  cover: Buffer | null,
  siblings: SeriesSpine[] = [],
): Promise<SpineJob> {
  const images = [
    reference,
    ...(cover ? [cover] : []),
    ...siblings.map(({ spine }) => spine),
  ]
  const jpegs = await Promise.all(images.map((image) => shrink(image, 1536)))
  const edges = cover && (await coverEdges(cover))
  // the volumes' spines follow the photo and the cover, counted from 1
  const firstSibling = cover ? 3 : 2
  const volumes = siblings
    .map(
      ({ seriesNumber }, index) =>
        `image ${firstSibling + index}${seriesNumber === null ? '' : ` (volume ${seriesNumber})`}`,
    )
    .join(', ')

  const drawing = await openai.responses.create({
    model: OPENAI_TEXT_MODEL,
    background: true,
    metadata: { step: 'drawing' satisfies Step, book: bookId },
    tools: [
      {
        type: 'image_generation',
        model: OPENAI_IMAGE_MODEL,
        action: 'edit',
        size: '1024x1536',
        quality: 'high',
        output_format: 'png',
        background: 'opaque',
      },
    ],
    tool_choice: { type: 'image_generation' },
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              `Draw the spine of the book ${describe(book)}, as a flat, straight-on scan.`,
              'The first image is a photo that shows this spine, maybe tilted, at an angle, in perspective or blurred.',
              cover &&
                'The second image is its front cover, as it is chosen for this book; the spine must join it seamlessly, continuing its background colour, texture and style along the edge.',
              edges &&
                `Measured on the cover, its colour along the left edge is ${edges.left} and along the right edge ${edges.right}. The spine joins the left edge, or the right one for a book read right to left, such as manga. Wherever the spine shares the cover’s background, use that exact colour: the photo’s lighting, shadows and camera tint the colours, so a white cover may look cream or beige and a black one grey in it, but the spine is printed in the cover’s own colours. Only where the photo clearly shows a different colour than the cover, such as a coloured band, keep that colour, matched in the cover’s brightness and tint.`,
              siblings.length > 0 &&
                `The spines of other volumes of the same series follow: ${volumes}. Series share a design, so wherever this photo shows the same kind of element, draw it the way they do: the spine colour and its bands, where and how the volume number sits, the series title, the author’s name, the publisher logo and their fonts. Use this volume’s own number and title from the photo, never theirs, and where the photo clearly differs from them, keep the photo.`,
              'Draw only the spine: a tall narrow upright rectangle, perfectly straight and sharp, filling the full height of the image, centred, on a plain pure white background with no shadow.',
              book.pages && spineShape(book.pages),
              'Straighten it by its own edges. Everything in the photo outside the spine’s edges is not part of the book: shelf, wall, table, neighbouring books, and the wedges of background a tilted spine leaves in the corners of the photo. Never carry any of it into the drawing, not even as a thin strip or triangle along a side, the top or the bottom; the spine’s own colour and design run right up to every edge. Where the photo cuts a part of the spine off, continue the spine’s own design there.',
              'Copy the photo’s spine exactly: the same lettering, its words, fonts, sizes, direction (usually reading top to bottom) and placement, the same publisher logo, ornaments and colours. Do not invent text; keep its proportions as a real spine of this thickness.',
            ]
              .filter(Boolean)
              .join('\n'),
          },
          ...jpegs.map((jpeg) => ({
            type: 'input_image' as const,
            image_url: dataUrl(jpeg),
            detail: 'high' as const,
          })),
        ],
      },
    ],
  })

  return working(drawing.id, 'drawing')
}

/** The painted spine cut out of the white it stands on, upright, as a PNG. */
async function drawnSpine(drawing: OpenAI.Responses.Response): Promise<Buffer> {
  const painted = drawing.output.find(
    (item) => item.type === 'image_generation_call' && item.result,
  )
  if (painted?.type !== 'image_generation_call' || !painted.result) {
    throw new SpineJobError('ChatGPT didn’t draw a spine, try again')
  }

  // the white around the spine goes, and a sideways one is stood up
  const trimmed = await sharp(Buffer.from(painted.result, 'base64'))
    .trim({ background: '#ffffff', threshold: 24 })
    .toBuffer({ resolveWithObject: true })
  const sideways = trimmed.info.width > trimmed.info.height

  return sharp(trimmed.data)
    .rotate(sideways ? 90 : 0)
    .resize({ height: DRAWN_HEIGHT, withoutEnlargement: true })
    .png()
    .toBuffer()
}
/** Looks in on a drawing for the book: still working, or the spine it drew. */
export async function followSpineJob(
  openai: OpenAI,
  bookId: string,
  jobId: string,
  log: FastifyBaseLogger,
): Promise<SpineJob> {
  const response = await openai.responses.retrieve(jobId)
  const metadata = (response.metadata ?? {}) as Record<string, string>
  if (metadata['book'] !== bookId) {
    throw new SpineJobError('That drawing isn’t for this book')
  }
  if (metadata['step'] !== ('drawing' satisfies Step)) {
    throw new SpineJobError('That isn’t a spine drawing')
  }

  if (response.status === 'queued' || response.status === 'in_progress') {
    return working(jobId, 'drawing', response.status === 'queued')
  }
  if (response.status !== 'completed') {
    throw new SpineJobError(
      response.error?.message ?? 'ChatGPT couldn’t finish, try again',
    )
  }

  // what a drawing costs, to see where the reader's money goes
  log.info(
    { book: bookId, model: response.model, usage: response.usage },
    'spine drawing finished',
  )

  return {
    status: 'done',
    image: (await drawnSpine(response)).toString('base64'),
  }
}
