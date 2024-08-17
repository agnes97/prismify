import { FastifyPluginAsync } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

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
            ratingItemA.finalRating - ratingItemB.finalRating,
        )

      const unratedItems = items
        .filter((item) => item.RatingVote.length < allParticipants.length)
        .map((item) => toRatingItem(item))

      const { Participants, ...rating } = ratingRecord
      return { ...rating, participants: Participants, ratedItems, unratedItems }
    },
  )
}

export default rating
