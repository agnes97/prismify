import multipart from '@fastify/multipart'
import { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

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
  bookEditSchema,
  coverPickSchema,
  readingSchema,
} from './library.validation.js'

/** under the 4.5 MB a Vercel function accepts; the library shrinks photos before sending */
const PHOTO_UPLOAD_LIMIT = 4 * 1024 * 1024
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp']

const library: FastifyPluginAsync = async (fastify, _opts): Promise<void> => {
  fastify.addHook('onRequest', fastify.authenticate)
  await fastify.register(multipart, {
    limits: { fileSize: PHOTO_UPLOAD_LIMIT, files: 1 },
  })

  const blobToken = fastify.config.BLOB_READ_WRITE_TOKEN || undefined

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
      const { title, authors, description } = request.body

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

  fastify.get('/readers', async function (_request, _reply) {
    return fastify.prisma.profile.findMany({
      select: { id: true, name: true, avatar: true },
      orderBy: { name: 'asc' },
    })
  })
}

export default library
