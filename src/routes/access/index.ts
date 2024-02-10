import { FastifyPluginAsync } from 'fastify'

const access: FastifyPluginAsync = async (fastify, _opts): Promise<void> => {
  fastify.get('/', async function (_request, _reply) {
    const ids = await fastify.prisma.access.findMany()
    return ids
  })
}

export default access
