import { FastifyPluginAsync } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { comparePassword } from './auth.helper.js'

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
})

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
        { id: user.id },
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
