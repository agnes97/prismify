import fp from 'fastify-plugin'
import { z } from 'zod'

const configSchema = z.object({
  JWT_SECRET: z.string().min(8),
  // covers stay on Open Library without it
  BLOB_READ_WRITE_TOKEN: z.string().optional(),
  // 32 random bytes in base64 that seal the readers' OpenAI keys; AI is off without it
  AI_KEYS_SECRET: z.string().optional(),
  // Brave Search API key the library finds photos of spines with; the library can't search for them without it
  BRAVE_SEARCH_API_KEY: z.string().optional(),
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
