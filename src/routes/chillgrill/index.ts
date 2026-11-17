import { AiProvider, AiPurpose, Prisma } from '@prisma/client'
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
  askSensei,
  pointsBySentence,
  pointsWithAi,
  SenseiError,
} from './chillgrill.sensei.js'
import {
  CATEGORIES,
  idParamsSchema,
  questionSchema,
  senseiSchema,
  SOURCE_TYPES,
  type CategoryName,
  type SourceTypeName,
} from './chillgrill.validation.js'

const questionSelect = {
  id: true,
  category: true,
  question: true,
  answer: true,
  points: true,
  sourceType: true,
  sourceUrl: true,
  sourceTitle: true,
  sourceAuthor: true,
  sourceChapter: true,
  createdAt: true,
} satisfies Prisma.ChillgrillQuestionSelect

type StoredQuestion = Prisma.ChillgrillQuestionGetPayload<{
  select: typeof questionSelect
}>

const nameOf = <T extends string>(map: Record<string, T>, value: T) =>
  Object.keys(map).find((key) => map[key] === value)

/** A question as clients get it, with its category and source by their JSON names. */
function toQuestion(stored: StoredQuestion) {
  const points = z.array(z.string()).safeParse(stored.points)
  return {
    id: stored.id,
    category: nameOf(CATEGORIES, stored.category) as CategoryName,
    question: stored.question,
    answer: stored.answer,
    points: points.success ? points.data : [],
    source: {
      type: nameOf(SOURCE_TYPES, stored.sourceType) as SourceTypeName,
      url: stored.sourceUrl ?? undefined,
      title: stored.sourceTitle ?? undefined,
      author: stored.sourceAuthor ?? undefined,
      chapter: stored.sourceChapter ?? undefined,
    },
    createdAt: stored.createdAt,
  }
}

const chillgrill: FastifyPluginAsync = async (
  fastify,
  _opts,
): Promise<void> => {
  fastify.addHook('onRequest', fastify.authenticate)

  const aiSecret = keysSecret(fastify.config.AI_KEYS_SECRET)

  /**
   * An OpenAI client on the user's own key, counted against their chillgrill
   * allowance, or the status and message to refuse with.
   */
  async function usersOpenai(
    request: FastifyRequest,
  ): Promise<OpenAI | { status: 409 | 429 | 503; message: string }> {
    if (!aiSecret) {
      return { status: 503, message: 'The sensei isn’t available right now' }
    }
    const openai = await openaiFor(fastify.prisma, aiSecret, request.user.id)
    if (!openai) {
      return { status: 409, message: 'Connect ChatGPT first' }
    }
    const refusal = await useAllowance(
      fastify.prisma,
      request.user.id,
      AiProvider.OPENAI,
      AiPurpose.CHILLGRILL,
    )
    return refusal ? { status: 429, message: refusal } : openai
  }

  fastify.get('/questions', async function (request, _reply) {
    const questions = await fastify.prisma.chillgrillQuestion.findMany({
      select: questionSelect,
      where: { profileId: request.user.id },
      orderBy: { createdAt: 'asc' },
    })
    return questions.map(toQuestion)
  })

  // ChatGPT splits the answer into the key points the sensei holds the user to;
  // without it connected, each sentence of the answer is one
  fastify
    .withTypeProvider<ZodTypeProvider>()
    .post(
      '/questions',
      { schema: { body: questionSchema } },
      async function (request, reply) {
        const { category, question, answer, source } = request.body

        let points: string[] | null = null
        const openai = await usersOpenai(request)
        if (openai instanceof OpenAI) {
          try {
            points = await pointsWithAi(openai, question, answer)
          } catch (error) {
            request.log.warn(
              { error },
              'Splitting an answer into points failed',
            )
          }
        } else if (openai.status === 429) {
          return reply.status(429).send({ message: openai.message })
        }

        const created = await fastify.prisma.chillgrillQuestion.create({
          select: questionSelect,
          data: {
            profileId: request.user.id,
            category: CATEGORIES[category],
            question,
            answer,
            points: points ?? pointsBySentence(answer),
            sourceType: SOURCE_TYPES[source.type],
            sourceUrl: source.type === 'webpage' ? source.url : null,
            sourceTitle: source.title ?? null,
            sourceAuthor:
              source.type === 'webpage' ? null : source.author ?? null,
            sourceChapter: source.type === 'chapter' ? source.chapter : null,
          },
        })
        return reply.status(201).send(toQuestion(created))
      },
    )

  fastify
    .withTypeProvider<ZodTypeProvider>()
    .delete(
      '/questions/:id',
      { schema: { params: idParamsSchema } },
      async function (request, reply) {
        const { count } = await fastify.prisma.chillgrillQuestion.deleteMany({
          where: { id: request.params.id, profileId: request.user.id },
        })
        if (count === 0) {
          return reply.status(404).send({ message: 'Question not found' })
        }
        return reply.status(204).send()
      },
    )

  // one turn of the grilling: the sensei weighs the latest answer and asks the next follow-up
  fastify
    .withTypeProvider<ZodTypeProvider>()
    .post(
      '/questions/:id/sensei',
      { schema: { params: idParamsSchema, body: senseiSchema } },
      async function (request, reply) {
        const stored = await fastify.prisma.chillgrillQuestion.findFirst({
          select: questionSelect,
          where: { id: request.params.id, profileId: request.user.id },
        })
        if (!stored) {
          return reply.status(404).send({ message: 'Question not found' })
        }

        const question = toQuestion(stored)
        const covered = request.body.covered.filter(
          (index) => index < question.points.length,
        )

        const openai = await usersOpenai(request)
        if (!(openai instanceof OpenAI)) {
          return reply.status(openai.status).send({ message: openai.message })
        }

        try {
          return await askSensei(openai, question, request.body.turns, covered)
        } catch (error) {
          if (error instanceof SenseiError) {
            return reply.status(502).send({ message: error.message })
          }
          return reply.status(502).send({ message: openaiProblem(error) })
        }
      },
    )
}

export default chillgrill
