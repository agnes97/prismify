import type { FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import fastifyJwt from '@fastify/jwt'
import { z } from 'zod'

const payloadSchema = z.object({
  id: z.string().uuid(),
})

type Payload = z.infer<typeof payloadSchema>

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: Payload
  }
}

async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    const payload = await request.jwtVerify()
    const result = payloadSchema.safeParse(payload)

    if (!result.success) {
      return reply.status(400).send(result.error)
    }
  } catch (error) {
    return reply.send(error)
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: typeof authenticate
  }
}

export default fp(async (fastify) => {
  await fastify.register(fastifyJwt, {
    secret: 'supersecret',
  })

  fastify.decorate('authenticate', authenticate)
})
