import { FastifyPluginAsync } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { categorizeItems, transformInputItems } from './item.helper.js'
import { itemSchema } from './item.validation.js'

// 1. get json from body ✅
// 2. validate through zod ✅
// 3. Map fields based on db schema ✅
// 4. Sort item to categories (item can have more categories) ✅
// 5. Store to db all at once with upsert (update insert - re-write if exists, create if not) ✅
// 6. Return success or error ✅

const oneMB = 1048576

const items: FastifyPluginAsync = async (fastify, _opts): Promise<void> => {
  fastify.withTypeProvider<ZodTypeProvider>().route({
    method: 'PUT',
    url: '/',
    bodyLimit: 5 * oneMB,
    schema: {
      body: z.array(itemSchema),
    },
    handler: async (request, reply) => {
      const categoryTypes = await fastify.prisma.categoryType.findMany({
        include: { categories: true },
      })

      const items = transformInputItems(request.body)
      const itemsWithCategories = categorizeItems(categoryTypes, items)

      await fastify.prisma.$transaction(
        itemsWithCategories.map(({ categories, ...item }) =>
          fastify.prisma.item.upsert({
            where: { id: item.id },
            create: {
              ...item,
              categories: {
                connect: categories.map((category) => ({
                  name: category.name,
                })),
              },
            },
            update: {
              ...item,
              categories: {
                connect: categories.map((category) => ({
                  name: category.name,
                })),
              },
            },
          }),
        ),
      )

      return reply.send()
    },
  })
}

export default items
