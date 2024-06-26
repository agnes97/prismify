import { FastifyPluginAsync } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { CV, maskData } from './cv.helper.js'

const cvSchema = z.object({
  accessCode: z.string(),
})

const MY_CV_ID = 'cv'

const cv: FastifyPluginAsync = async (fastify, _opts): Promise<void> => {
  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/',
    {
      schema: {
        body: cvSchema,
      },
    },
    async function (request, _reply) {
      const access = await fastify.prisma.access.findFirst({
        where: { id: request.body.accessCode },
      })

      const cv = await fastify.prisma.cV.findFirst({
        where: { id: MY_CV_ID },
      })

      const logCvAccess = async (accessCode: string) =>
        await fastify.prisma.accessLog.create({
          data: {
            accessCode,
          },
        })

      if (!access) return maskData(cv?.data as CV)

      await logCvAccess(access.id)
      return cv?.data
    },
  )
}

export default cv
