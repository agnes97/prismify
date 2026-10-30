import { lookup } from 'node:dns'
import type { IncomingMessage } from 'node:http'
import { request } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import type OpenAI from 'openai'
import { toFile } from 'openai'
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
 * Asks ChatGPT to search the web for photos that show the book's spine, then
 * downloads them and has it look at each beside the cover, keeping those that
 * really show the spine, the cover's own edition first.
 */
export async function findSpines(
  openai: OpenAI,
  book: SpineBook,
  cover: Buffer | null,
): Promise<SpineCandidate[]> {
  const coverJpeg = cover && (await shrink(cover, LOOK_SIDE))

  const search = await openai.responses.create({
    model: OPENAI_TEXT_MODEL,
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
          ...(coverJpeg
            ? [
                {
                  type: 'input_image' as const,
                  image_url: dataUrl(coverJpeg),
                  detail: 'low' as const,
                },
              ]
            : []),
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

  const found = foundSchema.parse(JSON.parse(search.output_text)).candidates
  const unique = [...new Map(found.map((c) => [c.imageUrl, c])).values()]
  const downloaded = (
    await Promise.all(
      unique.slice(0, MAX_FOUND).map(async (candidate) => {
        const image = await fetchImage(candidate.imageUrl)
        if (!image) return null
        try {
          return { ...candidate, jpeg: await shrink(image, LOOK_SIDE) }
        } catch {
          return null
        }
      }),
    )
  ).filter(<T>(candidate: T | null): candidate is T => candidate !== null)
  if (downloaded.length === 0) return []

  const vetting = await openai.responses.create({
    model: OPENAI_TEXT_MODEL,
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
          ...(coverJpeg
            ? [
                {
                  type: 'input_image' as const,
                  image_url: dataUrl(coverJpeg),
                  detail: 'low' as const,
                },
              ]
            : []),
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

  const { verdicts } = verdictSchema.parse(JSON.parse(vetting.output_text))
  const kept = verdicts
    .filter((verdict) => verdict.showsSpine)
    .sort((a, b) => Number(b.sameEdition) - Number(a.sameEdition))
    .flatMap(({ index, note }) => {
      const photo = downloaded[index]
      return photo ? [{ ...photo, note }] : []
    })

  return Promise.all(
    kept.map(async ({ imageUrl, pageUrl, jpeg, note }) => {
      const preview = await sharp(jpeg)
        .resize({ height: PREVIEW_HEIGHT, withoutEnlargement: true })
        .jpeg({ quality: 75 })
        .toBuffer()
      return { imageUrl, pageUrl, preview: dataUrl(preview), note }
    }),
  )
}

/**
 * Has ChatGPT paint the book's spine straight on and sharp, after a photo that
 * shows it (`reference`) and the cover it has to join, then cuts it out of the
 * white it stands on. Returns a PNG standing upright.
 */
export async function drawSpine(
  openai: OpenAI,
  book: SpineBook,
  reference: Buffer,
  cover: Buffer | null,
): Promise<Buffer> {
  const images = [
    await toFile(await shrink(reference, 1536), 'reference.jpg', {
      type: 'image/jpeg',
    }),
    ...(cover
      ? [
          await toFile(await shrink(cover, 1536), 'cover.jpg', {
            type: 'image/jpeg',
          }),
        ]
      : []),
  ]

  const result = await openai.images.edit({
    model: OPENAI_IMAGE_MODEL,
    image: images,
    size: '1024x1536',
    quality: 'high',
    output_format: 'png',
    background: 'opaque',
    prompt: [
      `The spine of the book ${describe(book)}, as a flat, straight-on scan.`,
      'The first image is a photo that shows this spine, maybe at an angle or blurred.',
      cover &&
        'The second image is its front cover; the spine must join it seamlessly, continuing its background colour, texture and style along the edge.',
      'Draw only the spine: a tall narrow upright rectangle, perfectly straight and sharp, filling the full height of the image, centred, on a plain pure white background with no shadow.',
      'Copy the photo’s spine exactly: the same lettering, its words, fonts, sizes, direction (usually reading top to bottom) and placement, the same publisher logo, ornaments and colours. Do not invent text; keep its proportions as a real spine of this thickness.',
    ]
      .filter(Boolean)
      .join('\n'),
  })

  const painted = result.data?.[0]?.b64_json
  if (!painted) throw new Error('No spine came back')

  // the white around the spine goes, and a sideways one is stood up
  const trimmed = await sharp(Buffer.from(painted, 'base64'))
    .trim({ background: '#ffffff', threshold: 24 })
    .toBuffer({ resolveWithObject: true })
  const sideways = trimmed.info.width > trimmed.info.height

  return sharp(trimmed.data)
    .rotate(sideways ? 90 : 0)
    .resize({ height: DRAWN_HEIGHT, withoutEnlargement: true })
    .png()
    .toBuffer()
}
