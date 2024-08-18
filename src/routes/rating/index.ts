import { FastifyPluginAsync } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library'

function add(...numbers: number[]): number {
  return numbers.reduce((sum, number) => sum + number, 0)
}

function average(numbers: number[]): number {
  return add(...numbers) / numbers.length
}

const rating: FastifyPluginAsync = async (fastify, _opts): Promise<void> => {
  fastify.addHook('onRequest', fastify.authenticate)

  fastify.get('/', async function (_request, _reply) {
    const ratings = await fastify.prisma.rating.findMany({
      select: { id: true, title: true },
    })

    return ratings
  })

  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/:id',
    {
      schema: {
        params: z.object({ id: z.string() }),
      },
    },
    async function (request, reply) {
      const ratingRecord = await fastify.prisma.rating.findUnique({
        select: {
          id: true,
          title: true,
          Participants: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        where: { id: request.params.id },
      })

      if (!ratingRecord) {
        return reply.status(404).send({ message: 'Rating not found' })
      }

      const items = await fastify.prisma.ratingItem.findMany({
        select: {
          id: true,
          title: true,
          data: true,
          favoriteById: true,
          RatingVote: {
            select: {
              participantId: true,
              rating: true,
            },
          },
        },
        where: { ratingId: ratingRecord.id },
      })

      const allParticipants = ratingRecord.Participants.map(
        (participant) => participant.id,
      )

      const toRatingItem = (item: (typeof items)[number]) => {
        const { RatingVote: votes, favoriteById, ...ratedItem } = item
        const currentUserVote = votes.find(
          (vote) => vote.participantId === request.user.id,
        )

        return {
          ...ratedItem,
          ...(!!currentUserVote && { myRating: currentUserVote.rating }),
          ...(!!favoriteById && { favoriteById }),
        }
      }

      const ratedItems = items
        .filter((item) => item.RatingVote.length === allParticipants.length)
        .map((item) => ({
          ...toRatingItem(item),
          finalRating: average(item.RatingVote.map((vote) => vote.rating)),
        }))
        .sort(
          (ratingItemA, ratingItemB) =>
            ratingItemB.finalRating - ratingItemA.finalRating,
        )

      const unratedItems = items
        .filter((item) => item.RatingVote.length < allParticipants.length)
        .map((item) => toRatingItem(item))

      const { Participants, ...rating } = ratingRecord
      return { ...rating, participants: Participants, ratedItems, unratedItems }
    },
  )

  fastify.withTypeProvider<ZodTypeProvider>().put(
    '/:id/votes',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.array(
          z.object({
            id: z.string().uuid(),
            rating: z.number().int(),
            isFavorite: z.boolean().optional(),
          }),
        ),
      },
    },
    async function (request, reply) {
      const votes = request.body

      const rating = await fastify.prisma.rating.findUnique({
        select: {
          hasFavorites: true,
          minRating: true,
          maxRating: true,
          Participants: {
            select: {
              id: true,
            },
          },
        },
        where: { id: request.params.id },
      })

      if (!rating) {
        return reply.status(404).send({ message: 'Rating not found' })
      }

      if (
        !rating.Participants.map((participant) => participant.id).includes(
          request.user.id,
        )
      ) {
        return reply
          .status(403)
          .send({ message: "Non-participants can't vote in ratings" })
      }

      if (
        !votes.every(
          (vote) =>
            vote.rating >= rating.minRating && vote.rating <= rating.maxRating,
        )
      ) {
        return reply.status(400).send({
          message: "Some of your votes are not in this rating's allowed range",
        })
      }

      const favouriteVotes = votes.filter((vote) => vote.isFavorite)

      if (rating.hasFavorites && favouriteVotes.length > 1) {
        return reply.status(400).send({
          message: 'You can vote only for one favorite in each rating',
        })
      }

      try {
        await fastify.prisma.$transaction(async (transaction) => {
          if (rating.hasFavorites && favouriteVotes.length === 1) {
            const favouriteVote = favouriteVotes[0]
            if (favouriteVote) {
              await transaction.ratingItem.updateMany({
                where: { favoriteById: request.user.id },
                data: { favoriteById: null },
              })

              await transaction.ratingItem.update({
                where: { id: favouriteVote.id },
                data: { favoriteById: request.user.id },
              })
            }
          }

          return Promise.all(
            votes.map((vote) =>
              transaction.ratingVote.upsert({
                where: {
                  ratingItemId_participantId: {
                    ratingItemId: vote.id,
                    participantId: request.user.id,
                  },
                },
                create: {
                  ratingItemId: vote.id,
                  participantId: request.user.id,
                  rating: vote.rating,
                },
                update: {
                  rating: vote.rating,
                },
              }),
            ),
          )
        })
      } catch (error) {
        if (
          error instanceof PrismaClientKnownRequestError &&
          error.code === 'P2025'
        ) {
          return reply.status(400).send({
            message: "Some items you are voting for don't exist",
          })
        }

        throw error
      }

      return reply.send({ message: 'Votes saved successfully' })
    },
  )
}

export default rating
