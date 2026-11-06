import { FastifyPluginAsync } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { comparePassword } from './auth.helper.js'

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
})

/** a token is renewed for 7 days at a time, but only up to this long after the password was typed */
const SESSION_MAX_AGE_SECONDS = 60 * 24 * 60 * 60

const auth: FastifyPluginAsync = async (fastify, _opts): Promise<void> => {
  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/login',
    {
      schema: {
        body: loginSchema,
      },
    },
    async (request, reply) => {
      const user = await fastify.prisma.user.findFirst({
        select: { id: true, password: true },
        where: {
          email: {
            equals: request.body.email,
            mode: 'insensitive',
          },
        },
      })

      if (
        !user ||
        !(await comparePassword(user.password, request.body.password))
      ) {
        return reply.status(401).send({ message: 'Invalid email or password' })
      }

      const accessToken = await reply.jwtSign(
        { id: user.id, authAt: Math.floor(Date.now() / 1000) },
        { expiresIn: '7d' },
      )

      await fastify.prisma.user.update({
        where: { id: user.id },
        data: {
          lastLoggedIn: new Date(),
        },
      })

      return reply.send({ accessToken })
    },
  )

  fastify.post(
    '/refresh',
    {
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      // tokens from before authAt count from when they were issued
      const authAt = request.user.authAt ?? request.user.iat ?? 0

      if (Date.now() / 1000 - authAt > SESSION_MAX_AGE_SECONDS) {
        return reply
          .status(401)
          .send({ message: 'Session too old, log in again' })
      }

      const accessToken = await reply.jwtSign(
        { id: request.user.id, authAt },
        { expiresIn: '7d' },
      )

      return reply.send({ accessToken })
    },
  )

  fastify.get(
    '/me',
    {
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const userId = request.user.id

      const userData = await fastify.prisma.user.findUnique({
        select: {
          id: true,
          email: true,
          lastLoggedIn: true,
          createdAt: true,
          profile: {
            select: {
              name: true,
              avatar: true,
            },
          },
        },
        where: { id: userId },
      })

      if (!userData) {
        return reply.status(404).send({ message: 'User not found' })
      }

      const { profile, ...user } = userData
      return reply.send({ ...user, ...profile })
    },
  )
}

export default auth
