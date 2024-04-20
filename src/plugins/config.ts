import fp from 'fastify-plugin'
import { z } from 'zod'

const configSchema = z.object({
  JWT_SECRET: z.string().min(8),
})

declare module 'fastify' {
  interface FastifyInstance {
    config: z.infer<typeof configSchema>
  }
}

export default fp(
  async (fastify) => {
    const config = await configSchema.parseAsync(process.env)
    fastify.decorate('config', config)
  },
  {
    name: 'config',
  },
)
