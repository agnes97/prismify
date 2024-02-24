import { FastifyPluginAsync } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { itemSchema } from './item.validation.js'

// 1. get json from body ✅
// 2. validate through zod ✅
// 3. Map fields based on db schema
// 4. Sort item to categories (item can have more categories)
// 5. Store to db all at once with upsert (update insert - re-write if exists, create if not)
// 6. Return success or error

const oneMB = 1048576

const items: FastifyPluginAsync = async (fastify, _opts): Promise<void> => {
  fastify.withTypeProvider<ZodTypeProvider>().route({
    method: 'PUT',
    url: '/',
    bodyLimit: 5 * oneMB,
    schema: {
      body: z.array(itemSchema),
    },
    handler: async (request, _reply) => {
      return request.body.map((item) => item.title)
    },
  })
}

export default items
