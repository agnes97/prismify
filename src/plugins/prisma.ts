import fp from 'fastify-plugin'
import { PrismaClient } from '@prisma/client'

// Use TypeScript module augmentation to declare the type of server.prisma to be PrismaClient
declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient
  }
}

export default fp(async (fastify) => {
  const prisma = new PrismaClient()

  await prisma.$connect()

  // Make Prisma Client available through the fastify server instance: server.prisma
  fastify.decorate('prisma', prisma)

  fastify.addHook('onClose', async (server) => {
    await server.prisma.$disconnect()
  })
})
