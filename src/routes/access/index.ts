import { FastifyPluginAsync } from 'fastify'

const access: FastifyPluginAsync = async (fastify, _opts): Promise<void> => {
  fastify.get<{ Querystring: { id?: string } }>(
    '/',
    async function (request, _reply) {
      const id = request.query.id

      if (!id) return false

      const accessRecord = await fastify.prisma.access.findFirst({
        where: { id },
      })

      return !!accessRecord
    },
  )
}

export default access
