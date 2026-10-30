import multipart from '@fastify/multipart'
import { AiProvider } from '@prisma/client'
import { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import OpenAI from 'openai'
import { z } from 'zod'

import {
  keysSecret,
  openaiFor,
  openaiProblem,
  useAllowance,
} from '../ai/ai.helper.js'

import {
  bookSelect,
  fetchDescription,
  parseRead,
  readingSelect,
  toReading,
} from './library.helper.js'
import {
  type Cover,
  deleteImage,
  mirrorCover,
  type Spine,
  storeCover,
  storeSpine,
} from './library.cover.js'
import {
  fetchImage,
  followSpineJob,
  type SeriesSpine,
  type SpineBook,
  type SpineJob,
  SpineJobError,
  startSpineDrawing,
  startSpineSearch,
} from './library.spine.js'
import {
  bookEditSchema,
  coverPickSchema,
  readingSchema,
  spineDrawSchema,
  spineJobSchema,
  spineSearchSchema,
} from './library.validation.js'

/** under the 4.5 MB a Vercel function accepts; the library shrinks photos before sending */
const PHOTO_UPLOAD_LIMIT = 4 * 1024 * 1024
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp']
/** how many other volumes' spines a drawing follows, the nearest in the series */
const SERIES_SPINES = 2

const library: FastifyPluginAsync = async (fastify, _opts): Promise<void> => {
  fastify.addHook('onRequest', fastify.authenticate)
  await fastify.register(multipart, {
    limits: { fileSize: PHOTO_UPLOAD_LIMIT, files: 1 },
  })

  const blobToken = fastify.config.BLOB_READ_WRITE_TOKEN || undefined
  const aiSecret = keysSecret(fastify.config.AI_KEYS_SECRET)
  const imageSearchKey = fastify.config.BRAVE_SEARCH_API_KEY || undefined

  /**
   * An OpenAI client on the reader's own key, or the status and message to
   * refuse with. Starting a search or drawing is `counted` against their
   * allowance; looking in on one isn't.
   */
  async function readersOpenai(
    request: FastifyRequest,
    counted: boolean,
  ): Promise<OpenAI | { status: 409 | 429 | 503; message: string }> {
    if (!aiSecret) {
      return { status: 503, message: 'AI spines aren’t available right now' }
    }
    const openai = await openaiFor(fastify.prisma, aiSecret, request.user.id)
    if (!openai) {
      return {
        status: 409,
        message: 'Connect ChatGPT under AI Keys in the menu first',
      }
    }
    if (!counted) return openai

    const refusal = await useAllowance(
      fastify.prisma,
      request.user.id,
      AiProvider.OPENAI,
    )
    return refusal ? { status: 429, message: refusal } : openai
  }

  /** What to tell the reader when a step of finding or drawing a spine fails. */
  function spineProblem(error: unknown): {
    status: 404 | 502
    message: string
  } {
    if (error instanceof SpineJobError) {
      return { status: 502, message: error.message }
    }
    if (error instanceof OpenAI.NotFoundError) {
      return { status: 404, message: 'That search is gone, start again' }
    }
    return { status: 502, message: openaiProblem(error) }
  }

  /** The book as the spine is looked for and drawn after, with its cover, or null when there is no such book. */
  async function spineBook(id: string) {
    const book = await fastify.prisma.libraryBook.findUnique({
      select: {
        title: true,
        authors: true,
        year: true,
        isbn: true,
        series: true,
        seriesNumber: true,
        pages: true,
        coverUrl: true,
      },
      where: { id },
    })
    if (!book) return null

    const { coverUrl, ...details } = book
    return {
      book: details,
      cover: coverUrl ? await fetchImage(coverUrl) : null,
    }
  }

  /**
   * The photographed spines of the volumes nearest the book in its series, for
   * the drawing to follow their shared design; none when it has no series.
   */
  async function seriesSpines(
    id: string,
    { series, seriesNumber }: SpineBook,
  ): Promise<SeriesSpine[]> {
    if (!series) return []
    const volumes = await fastify.prisma.libraryBook.findMany({
      select: { seriesNumber: true, spineUrl: true },
      where: { series, id: { not: id }, spineUrl: { not: null } },
    })
    const distance = (number: number | null) =>
      seriesNumber === null || number === null
        ? Infinity
        : Math.abs(number - seriesNumber)
    const nearest = volumes
      .sort((a, b) => distance(a.seriesNumber) - distance(b.seriesNumber))
      .slice(0, SERIES_SPINES)

    const spines = await Promise.all(
      nearest.map(async ({ seriesNumber, spineUrl }) => {
        const spine = spineUrl && (await fetchImage(spineUrl))
        return spine ? { seriesNumber, spine } : null
      }),
    )
    return spines.filter((spine): spine is SeriesSpine => spine !== null)
  }

  /** The photo sent as multipart, or the status and message to refuse it with. */
  async function uploadedPhoto(
    request: FastifyRequest,
  ): Promise<Buffer | { status: 400 | 413; message: string }> {
    const file = await request.file()
    if (!file || !PHOTO_TYPES.includes(file.mimetype)) {
      return {
        status: 400,
        message: 'The photo must be a JPEG, PNG or WebP image',
      }
    }

    try {
      return await file.toBuffer()
    } catch (error) {
      if (error instanceof fastify.multipartErrors.RequestFileTooLargeError) {
        return {
          status: 413,
          message: 'The photo is too big, keep it under 4 MB',
        }
      }
      throw error
    }
  }

  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/readings',
    {
      schema: {
        querystring: z.object({ readById: z.string().uuid().optional() }),
      },
    },
    async function (request, _reply) {
      const readings = await fastify.prisma.libraryReading.findMany({
        select: readingSelect,
        where: {
          ...(!!request.query.readById && { readById: request.query.readById }),
        },
        // newest read first; readings with only a year follow the dated ones of
        // their year, newest added first
        orderBy: [
          { readYear: 'desc' },
          { readDate: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
        ],
      })

      return readings.map(toReading)
    },
  )

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/readings',
    {
      schema: {
        body: readingSchema,
      },
    },
    async function (request, reply) {
      // only your own readings can be added
      const { book, read } = request.body

      const parsed = parseRead(read)
      if (!parsed) {
        return reply.status(400).send({
          message: 'The day you read it must be a real day, not in the future',
        })
      }

      const bookId = book.key.replace('/works/', '')

      const storedBook = await fastify.prisma.libraryBook.findUnique({
        select: { id: true },
        where: { id: bookId },
      })

      // fetched outside the transaction, and only for a book not on any shelf yet
      const [description, cover] = storedBook
        ? [null, null]
        : await Promise.all([
            fetchDescription(bookId),
            book.coverUrl
              ? mirrorCover(blobToken, bookId, book.coverUrl)
              : null,
          ])

      const [, reading] = await fastify.prisma.$transaction([
        fastify.prisma.libraryBook.upsert({
          where: { id: bookId },
          create: {
            id: bookId,
            title: book.title,
            authors: book.authors,
            year: book.year ?? null,
            pages: book.pages ?? null,
            // Open Library's own until the backfill mirrors it
            coverUrl: cover?.coverUrl ?? book.coverUrl ?? null,
            coverColor: cover?.coverColor ?? null,
            isbn: book.isbn ?? null,
            description,
          },
          // the reader may have corrected the title and authors before adding it
          update: { title: book.title, authors: book.authors },
        }),
        fastify.prisma.libraryReading.create({
          select: readingSelect,
          data: {
            bookId,
            ...parsed,
            readById: request.user.id,
            addedById: request.user.id,
          },
        }),
      ])

      return reply.status(201).send(toReading(reading))
    },
  )

  fastify.withTypeProvider<ZodTypeProvider>().delete(
    '/readings/:id',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async function (request, reply) {
      const reading = await fastify.prisma.libraryReading.findUnique({
        select: { readById: true, bookId: true },
        where: { id: request.params.id },
      })

      if (!reading) {
        return reply.status(404).send({ message: 'Reading not found' })
      }
      // only your own readings can be taken off the shelf
      if (reading.readById !== request.user.id) {
        return reply
          .status(403)
          .send({ message: 'Only the reader can remove this book' })
      }

      await fastify.prisma.$transaction([
        fastify.prisma.libraryReading.delete({
          where: { id: request.params.id },
        }),
        // the book goes too once nobody has it on a shelf
        fastify.prisma.libraryBook.deleteMany({
          where: { id: reading.bookId, Readings: { none: {} } },
        }),
      ])

      return reply.status(204).send()
    },
  )

  fastify.withTypeProvider<ZodTypeProvider>().patch(
    '/books/:id',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: bookEditSchema,
      },
    },
    async function (request, reply) {
      // books are shared by every reader, so anyone can correct one
      const { title, authors, description, series, seriesNumber } = request.body

      const book = await fastify.prisma.libraryBook.findUnique({
        select: { id: true },
        where: { id: request.params.id },
      })
      if (!book) {
        return reply.status(404).send({ message: 'Book not found' })
      }

      return fastify.prisma.libraryBook.update({
        select: bookSelect,
        where: { id: book.id },
        data: {
          ...(title !== undefined && { title }),
          ...(authors !== undefined && { authors }),
          ...(description !== undefined && {
            description: description || null,
          }),
          ...(seriesNumber !== undefined && { seriesNumber }),
          ...(series !== undefined && {
            series: series || null,
            ...(!series && { seriesNumber: null }),
          }),
        },
      })
    },
  )

  fastify.withTypeProvider<ZodTypeProvider>().put(
    '/books/:id/cover',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: coverPickSchema,
      },
    },
    async function (request, reply) {
      // books are shared by every reader, so anyone can give one a better cover
      if (!blobToken) {
        return reply
          .status(503)
          .send({ message: 'Covers can’t be changed right now' })
      }

      const book = await fastify.prisma.libraryBook.findUnique({
        select: { id: true, coverUrl: true },
        where: { id: request.params.id },
      })
      if (!book) {
        return reply.status(404).send({ message: 'Book not found' })
      }

      let cover: Cover | null
      if (request.isMultipart()) {
        const image = await uploadedPhoto(request)
        if (!Buffer.isBuffer(image)) {
          return reply.status(image.status).send({ message: image.message })
        }

        try {
          cover = await storeCover(blobToken, book.id, image)
        } catch {
          return reply
            .status(400)
            .send({ message: 'That photo can’t be read as an image' })
        }
      } else if (request.body) {
        cover = await mirrorCover(blobToken, book.id, request.body.coverUrl)
        if (!cover) {
          return reply
            .status(400)
            .send({ message: 'That cover can’t be fetched from Open Library' })
        }
      } else {
        return reply.status(400).send({ message: 'No cover to put on it' })
      }

      const updated = await fastify.prisma.libraryBook.update({
        select: bookSelect,
        where: { id: book.id },
        data: cover,
      })

      if (book.coverUrl !== cover.coverUrl) {
        await deleteImage(blobToken, book.coverUrl)
      }

      return updated
    },
  )

  fastify.withTypeProvider<ZodTypeProvider>().put(
    '/books/:id/spine',
    {
      schema: {
        params: z.object({ id: z.string() }),
      },
    },
    async function (request, reply) {
      // books are shared by every reader, so anyone can photograph the spine
      if (!blobToken) {
        return reply
          .status(503)
          .send({ message: 'Spines can’t be changed right now' })
      }

      const book = await fastify.prisma.libraryBook.findUnique({
        select: { id: true, spineUrl: true },
        where: { id: request.params.id },
      })
      if (!book) {
        return reply.status(404).send({ message: 'Book not found' })
      }
      if (!request.isMultipart()) {
        return reply.status(400).send({ message: 'No photo of the spine' })
      }

      const image = await uploadedPhoto(request)
      if (!Buffer.isBuffer(image)) {
        return reply.status(image.status).send({ message: image.message })
      }

      let spine: Spine
      try {
        spine = await storeSpine(blobToken, book.id, image)
      } catch {
        return reply
          .status(400)
          .send({ message: 'That photo can’t be read as an image' })
      }

      const updated = await fastify.prisma.libraryBook.update({
        select: bookSelect,
        where: { id: book.id },
        data: spine,
      })

      if (book.spineUrl !== spine.spineUrl) {
        await deleteImage(blobToken, book.spineUrl)
      }

      return updated
    },
  )

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/books/:id/spine/candidates',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: spineSearchSchema,
      },
    },
    async function (request, reply) {
      // searched on the reader's own OpenAI key in the background; the
      // library follows it at /books/:id/spine/jobs/:job and nothing is stored
      const openai = await readersOpenai(request, true)
      if (!('responses' in openai)) {
        return reply.status(openai.status).send({ message: openai.message })
      }

      const found = await spineBook(request.params.id)
      if (!found) {
        return reply.status(404).send({ message: 'Book not found' })
      }

      try {
        return await startSpineSearch(
          openai,
          request.params.id,
          found.book,
          found.cover,
          request.body?.seen,
          imageSearchKey,
        )
      } catch (error) {
        request.log.warn(error, 'spine search failed')
        const problem = spineProblem(error)
        return reply.status(problem.status).send({ message: problem.message })
      }
    },
  )

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/books/:id/spine/draw',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: spineDrawSchema,
      },
    },
    async function (request, reply) {
      // drawn on the reader's own OpenAI key in the background and only shown;
      // the library saves it through PUT /books/:id/spine once the reader likes it
      const openai = await readersOpenai(request, true)
      if (!('responses' in openai)) {
        return reply.status(openai.status).send({ message: openai.message })
      }

      const found = await spineBook(request.params.id)
      if (!found) {
        return reply.status(404).send({ message: 'Book not found' })
      }

      let reference: Buffer | null
      if (request.isMultipart()) {
        const image = await uploadedPhoto(request)
        if (!Buffer.isBuffer(image)) {
          return reply.status(image.status).send({ message: image.message })
        }
        reference = image
      } else if (request.body) {
        reference = await fetchImage(request.body.imageUrl)
        if (!reference) {
          return reply
            .status(400)
            .send({ message: 'That photo can’t be fetched any more' })
        }
      } else {
        return reply.status(400).send({ message: 'No photo to draw it after' })
      }

      try {
        return await startSpineDrawing(
          openai,
          request.params.id,
          found.book,
          reference,
          found.cover,
          await seriesSpines(request.params.id, found.book),
        )
      } catch (error) {
        request.log.warn(error, 'spine drawing failed')
        const problem = spineProblem(error)
        return reply.status(problem.status).send({ message: problem.message })
      }
    },
  )

  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/books/:id/spine/jobs/:job',
    {
      schema: {
        params: z.object({ id: z.string(), job: spineJobSchema }),
      },
    },
    async function (request, reply): Promise<SpineJob | undefined> {
      // looking in on a search or drawing isn't counted against the allowance;
      // only the reader's own key can read it
      const openai = await readersOpenai(request, false)
      if (!('responses' in openai)) {
        return reply.status(openai.status).send({ message: openai.message })
      }

      const { id, job } = request.params
      try {
        return await followSpineJob(
          openai,
          id,
          job,
          async () => {
            const found = await spineBook(id)
            if (!found) throw new SpineJobError('Book not found')
            return found
          },
          request.log,
        )
      } catch (error) {
        request.log.warn(error, 'spine job failed')
        const problem = spineProblem(error)
        return reply.status(problem.status).send({ message: problem.message })
      }
    },
  )

  fastify.withTypeProvider<ZodTypeProvider>().delete(
    '/books/:id/spine',
    {
      schema: {
        params: z.object({ id: z.string() }),
      },
    },
    async function (request, reply) {
      // back to the cloth one, dyed after the cover
      const book = await fastify.prisma.libraryBook.findUnique({
        select: { id: true, spineUrl: true },
        where: { id: request.params.id },
      })
      if (!book) {
        return reply.status(404).send({ message: 'Book not found' })
      }

      const updated = await fastify.prisma.libraryBook.update({
        select: bookSelect,
        where: { id: book.id },
        data: { spineUrl: null, spineColor: null, spineRatio: null },
      })
      await deleteImage(blobToken, book.spineUrl)

      return updated
    },
  )

  fastify.withTypeProvider<ZodTypeProvider>().delete(
    '/books/:id/cover',
    {
      schema: {
        params: z.object({ id: z.string() }),
      },
    },
    async function (request, reply) {
      // plain cloth with the title on, still dyed after the cover it had
      const book = await fastify.prisma.libraryBook.findUnique({
        select: { id: true, coverUrl: true },
        where: { id: request.params.id },
      })
      if (!book) {
        return reply.status(404).send({ message: 'Book not found' })
      }

      const updated = await fastify.prisma.libraryBook.update({
        select: bookSelect,
        where: { id: book.id },
        data: { coverUrl: null },
      })
      await deleteImage(blobToken, book.coverUrl)

      return updated
    },
  )

  fastify.get('/readers', async function (_request, _reply) {
    return fastify.prisma.profile.findMany({
      select: { id: true, name: true, avatar: true },
      orderBy: { name: 'asc' },
    })
  })
}

export default library
