import { lookup } from 'node:dns'
import type { IncomingMessage } from 'node:http'
import { request } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
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
}

export type SpineCandidate = {
  /** the photo on the web, sent back to draw the spine after */
  imageUrl: string
  /** the page it was found on */
  pageUrl: string
  /** a small JPEG of it as a data URL, as many sites won't show their photos elsewhere */
  preview: string
  /** what the photo shows, in a few words */
  note: string
}

/** how many photos the search may suggest, and how many are looked at */
const MAX_FOUND = 10
/** a found photo bigger than this isn't a photo of a book */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** photos are shrunk to this before the models see them, which is plenty to read a spine */
const LOOK_SIDE = 1024
const PREVIEW_HEIGHT = 240
/** the drawn spine is kept this tall; the shelf stores it at half */
const DRAWN_HEIGHT = 1280

const describe = ({ title, authors, year, isbn }: SpineBook) =>
  [
    `"${title}"`,
    authors.length > 0 && `by ${authors.join(', ')}`,
    year && `(${year})`,
    isbn && `ISBN ${isbn}`,
  ]
    .filter(Boolean)
    .join(' ')

const dataUrl = (jpeg: Buffer) =>
  `data:image/jpeg;base64,${jpeg.toString('base64')}`

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

const foundSchema = z.object({
  candidates: z.array(z.object({ imageUrl: z.string(), pageUrl: z.string() })),
})

const verdictSchema = z.object({
  verdicts: z.array(
    z.object({
      index: z.number().int(),
      showsSpine: z.boolean(),
      sameEdition: z.boolean(),
      note: z.string(),
    }),
  ),
})

/**
 * Finding and drawing a spine take longer than a Vercel function may run, so
 * each runs at OpenAI in the background as a response the library polls for,
 * by its id. Only the reader's own key can read it. Its metadata says which
 * step it is and carries what the next step needs.
 */
export type SpineJob =
  | {
      status: 'working'
      job: string
      /** which step is running, so the reader can be told */
      step: Step
      /** still waiting its turn at OpenAI */
      queued: boolean
      /** how many found photos are being looked at, while vetting */
      photos?: number
    }
  | { status: 'done'; candidates: SpineCandidate[] }
  | { status: 'done'; image: string }

type Step = 'search' | 'vetting' | 'drawing'

/** A step that ran but came to nothing, with what to tell the reader. */
export class SpineJobError extends Error {}

const working = (
  job: string,
  step: Step,
  queued = true,
  photos?: number,
): SpineJob => ({
  status: 'working',
  job,
  step,
  queued,
  ...(photos !== undefined && { photos }),
})

const coverImage = (coverJpeg: Buffer | null) =>
  coverJpeg
    ? [
        {
          type: 'input_image' as const,
          image_url: dataUrl(coverJpeg),
          detail: 'low' as const,
        },
      ]
    : []

/** Starts ChatGPT searching the web for photos that show the book's spine. */
export async function startSpineSearch(
  openai: OpenAI,
  bookId: string,
  book: SpineBook,
  cover: Buffer | null,
): Promise<SpineJob> {
  const coverJpeg = cover && (await shrink(cover, LOOK_SIDE))

  const search = await openai.responses.create({
    model: OPENAI_TEXT_MODEL,
    background: true,
    metadata: { step: 'search' satisfies Step, book: bookId },
    tools: [{ type: 'web_search' }],
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              `Find photos on the web that show the spine of the book ${describe(book)}.`,
              coverJpeg &&
                'The attached image is its cover: prefer this same edition.',
              'Good sources: bookshop and publisher listings with angled or 3D product shots, back-and-spine images, photos of the book on a shelf, second-hand listings with several photos.',
              `Give up to ${MAX_FOUND} direct image URLs (the image file itself, e.g. ending in .jpg or served by an image CDN, not the page), each with the page it is on. Only include URLs you actually saw in search results or pages; never guess one.`,
            ]
              .filter(Boolean)
              .join('\n'),
          },
          ...coverImage(coverJpeg),
        ],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'spine_photos',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['candidates'],
          properties: {
            candidates: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['imageUrl', 'pageUrl'],
                properties: {
                  imageUrl: { type: 'string' },
                  pageUrl: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  })

  return working(search.id, 'search')
}

/** The photos a finished search found, each once, as many as are looked at. */
async function foundPhotos(openai: OpenAI, searchId: string) {
  const search = await openai.responses.retrieve(searchId)
  const found = foundSchema.parse(JSON.parse(search.output_text)).candidates
  return [...new Map(found.map((c) => [c.imageUrl, c])).values()].slice(
    0,
    MAX_FOUND,
  )
}

/**
 * Downloads the photos the search found and starts ChatGPT looking at each
 * beside the cover, to keep only those that really show the spine.
 */
async function startVetting(
  openai: OpenAI,
  bookId: string,
  searchId: string,
  book: SpineBook,
  cover: Buffer | null,
): Promise<SpineJob> {
  const photos = await foundPhotos(openai, searchId)
  const downloaded = (
    await Promise.all(
      photos.map(async (photo, index) => {
        const image = await fetchImage(photo.imageUrl)
        if (!image) return null
        try {
          return { index, jpeg: await shrink(image, LOOK_SIDE) }
        } catch {
          return null
        }
      }),
    )
  ).filter(<T>(photo: T | null): photo is T => photo !== null)
  if (downloaded.length === 0) return { status: 'done', candidates: [] }

  const coverJpeg = cover && (await shrink(cover, LOOK_SIDE))
  const vetting = await openai.responses.create({
    model: OPENAI_TEXT_MODEL,
    background: true,
    metadata: {
      step: 'vetting' satisfies Step,
      book: bookId,
      search: searchId,
      // which of the search's photos were looked at, in the order shown
      photos: downloaded.map(({ index }) => index).join(','),
    },
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              `These are photos found for the book ${describe(book)}.`,
              coverJpeg
                ? 'The first image is its cover; the photos follow, numbered from 0.'
                : 'The photos are numbered from 0.',
              'For each photo, say whether the book’s spine is visible clearly enough to read its lettering (showsSpine), whether it is the same edition as the cover, matching its design (sameEdition), and in a few words what the photo shows (note).',
            ].join('\n'),
          },
          ...coverImage(coverJpeg),
          ...downloaded.flatMap(({ jpeg }, index) => [
            { type: 'input_text' as const, text: `Photo ${index}:` },
            {
              type: 'input_image' as const,
              image_url: dataUrl(jpeg),
              detail: 'auto' as const,
            },
          ]),
        ],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'spine_verdicts',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['verdicts'],
          properties: {
            verdicts: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['index', 'showsSpine', 'sameEdition', 'note'],
                properties: {
                  index: { type: 'integer' },
                  showsSpine: { type: 'boolean' },
                  sameEdition: { type: 'boolean' },
                  note: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  })

  return working(vetting.id, 'vetting', true, downloaded.length)
}

/** The photos ChatGPT kept, the cover's own edition first, each with a small preview. */
async function vettedPhotos(
  openai: OpenAI,
  vetting: OpenAI.Responses.Response,
  metadata: Record<string, string>,
): Promise<SpineCandidate[]> {
  const photos = await foundPhotos(openai, metadata['search'] ?? '')
  const shown = (metadata['photos'] ?? '').split(',').map(Number)
  const { verdicts } = verdictSchema.parse(JSON.parse(vetting.output_text))

  const kept = verdicts
    .filter((verdict) => verdict.showsSpine)
    .sort((a, b) => Number(b.sameEdition) - Number(a.sameEdition))
    .flatMap(({ index, note }) => {
      const photo = photos[shown[index] ?? -1]
      return photo ? [{ ...photo, note }] : []
    })

  // fetched again for the previews, as nothing was kept between the steps
  const candidates = await Promise.all(
    kept.map(async ({ imageUrl, pageUrl, note }) => {
      const image = await fetchImage(imageUrl)
      if (!image) return null
      try {
        const preview = await sharp(image)
          .rotate()
          .resize({ height: PREVIEW_HEIGHT, withoutEnlargement: true })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: 75 })
          .toBuffer()
        return { imageUrl, pageUrl, preview: dataUrl(preview), note }
      } catch {
        return null
      }
    }),
  )
  return candidates.filter(
    (candidate): candidate is SpineCandidate => candidate !== null,
  )
}

/**
 * Starts ChatGPT painting the book's spine straight on and sharp, after a photo
 * that shows it (`reference`) and the cover it has to join.
 */
export async function startSpineDrawing(
  openai: OpenAI,
  bookId: string,
  book: SpineBook,
  reference: Buffer,
  cover: Buffer | null,
): Promise<SpineJob> {
  const images = [reference, ...(cover ? [cover] : [])]
  const jpegs = await Promise.all(images.map((image) => shrink(image, 1536)))

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
              'The first image is a photo that shows this spine, maybe at an angle or blurred.',
              cover &&
                'The second image is its front cover; the spine must join it seamlessly, continuing its background colour, texture and style along the edge.',
              'Draw only the spine: a tall narrow upright rectangle, perfectly straight and sharp, filling the full height of the image, centred, on a plain pure white background with no shadow.',
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

/**
 * Looks in on a step for the book: still working, the next step started, or
 * what it came to. `spineBook` loads the book and its cover when a step needs
 * them again.
 */
export async function followSpineJob(
  openai: OpenAI,
  bookId: string,
  jobId: string,
  spineBook: () => Promise<{ book: SpineBook; cover: Buffer | null }>,
): Promise<SpineJob> {
  const response = await openai.responses.retrieve(jobId)
  const metadata = (response.metadata ?? {}) as Record<string, string>
  if (metadata['book'] !== bookId) {
    throw new SpineJobError('That search isn’t for this book')
  }

  const step = metadata['step'] as Step
  if (response.status === 'queued' || response.status === 'in_progress') {
    const photos = metadata['photos']?.split(',').length
    return working(jobId, step, response.status === 'queued', photos)
  }
  if (response.status !== 'completed') {
    throw new SpineJobError(
      response.error?.message ?? 'ChatGPT couldn’t finish, try again',
    )
  }

  switch (step) {
    case 'search': {
      const { book, cover } = await spineBook()
      return startVetting(openai, bookId, jobId, book, cover)
    }
    case 'vetting':
      return {
        status: 'done',
        candidates: await vettedPhotos(openai, response, metadata),
      }
    case 'drawing':
      return {
        status: 'done',
        image: (await drawnSpine(response)).toString('base64'),
      }
    default:
      throw new SpineJobError('That isn’t a spine search or drawing')
  }
}
