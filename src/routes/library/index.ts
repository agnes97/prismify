import { FastifyPluginAsync } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

import {
  fetchDescription,
  parseRead,
  readingSelect,
  toReading,
} from './library.helper.js'
import { readingSchema } from './library.validation.js'

const library: FastifyPluginAsync = async (fastify, _opts): Promise<void> => {
  fastify.addHook('onRequest', fastify.authenticate)

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
      const { book, read, readById = request.user.id } = request.body

      const parsed = parseRead(read)
      if (!parsed) {
        return reply.status(400).send({
          message: 'The day you read it must be a real day, not in the future',
        })
      }

      const reader = await fastify.prisma.profile.findUnique({
        select: { id: true },
        where: { id: readById },
      })

      if (!reader) {
        return reply.status(400).send({ message: 'Reader not found' })
      }

      const bookId = book.key.replace('/works/', '')

      const storedBook = await fastify.prisma.libraryBook.findUnique({
        select: { id: true },
        where: { id: bookId },
      })

      // fetched outside the transaction, and only for a book not on any shelf yet
      const description = storedBook ? null : await fetchDescription(bookId)

      const [, reading] = await fastify.prisma.$transaction([
        fastify.prisma.libraryBook.upsert({
          where: { id: bookId },
          create: {
            id: bookId,
            title: book.title,
            authors: book.authors,
            year: book.year ?? null,
            pages: book.pages ?? null,
            coverUrl: book.coverUrl ?? null,
            isbn: book.isbn ?? null,
            description,
          },
          update: {},
        }),
        fastify.prisma.libraryReading.create({
          select: readingSelect,
          data: {
            bookId,
            ...parsed,
            readById,
            addedById: request.user.id,
          },
        }),
      ])

      return reply.status(201).send(toReading(reading))
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
