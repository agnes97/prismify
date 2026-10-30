import { FastifyPluginAsync } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'

import {
  keyProblem,
  keysSecret,
  PROVIDER_NAMES,
  PROVIDERS,
  readersKeys,
  sealKey,
} from './ai.helper.js'
import { aiKeySchema, providerParamsSchema } from './ai.validation.js'

const ai: FastifyPluginAsync = async (fastify, _opts): Promise<void> => {
  fastify.addHook('onRequest', fastify.authenticate)

  const secret = keysSecret(fastify.config.AI_KEYS_SECRET)

  // which keys are connected, by their last characters, never the keys themselves
  fastify.get('/keys', async function (request, _reply) {
    const keys =
      secret && (await readersKeys(fastify.prisma, secret, request.user.id))

    return Object.fromEntries(
      PROVIDER_NAMES.map((name) => {
        const key = keys && keys.get(PROVIDERS[name])
        return [name, key ? { hint: key.hint } : null]
      }),
    )
  })

  fastify.withTypeProvider<ZodTypeProvider>().put(
    '/keys/:provider',
    {
      schema: {
        params: providerParamsSchema,
        body: aiKeySchema,
      },
    },
    async function (request, reply) {
      if (!secret) {
        return reply
          .status(503)
          .send({ message: 'AI keys can’t be connected right now' })
      }

      const provider = PROVIDERS[request.params.provider]
      const { key } = request.body

      const problem = await keyProblem(provider, key)
      if (problem) {
        return reply.status(400).send({ message: problem })
      }

      const userId = request.user.id
      const data = { cipher: sealKey(secret, key), hint: key.slice(-4) }
      return fastify.prisma.aiKey.upsert({
        select: { hint: true },
        where: { userId_provider: { userId, provider } },
        create: { userId, provider, ...data },
        update: data,
      })
    },
  )

  fastify.withTypeProvider<ZodTypeProvider>().delete(
    '/keys/:provider',
    {
      schema: {
        params: providerParamsSchema,
      },
    },
    async function (request, reply) {
      await fastify.prisma.aiKey.deleteMany({
        where: {
          userId: request.user.id,
          provider: PROVIDERS[request.params.provider],
        },
      })
      return reply.status(204).send()
    },
  )
}

export default ai
