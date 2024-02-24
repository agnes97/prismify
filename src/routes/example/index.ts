import { FastifyPluginAsync } from 'fastify'

const example: FastifyPluginAsync = async (fastify, _opts): Promise<void> => {
  fastify.get('/', async function (_request, _reply) {
    return fastify.prisma.category.findMany({
      where: { categoryTypeName: 'brand' },
      orderBy: { name: 'asc' },
    })
  })
}

export default example
