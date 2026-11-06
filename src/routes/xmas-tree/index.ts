import { FastifyPluginAsync } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

// Where each bauble hangs from, in units of the tree's height: x from the trunk,
// y down from the top (a little above it for a bauble on the tip); and its story:
// the year it joined the tree and a few words about it.
const baublesSchema = z
  .record(
    z.string().min(1).max(32),
    z.object({
      x: z.number().min(-0.5).max(0.5),
      y: z.number().min(-0.2).max(1),
      year: z.number().int().min(1900).max(2100).optional(),
      description: z.string().max(500).optional(),
    }),
  )
  .refine((baubles) => Object.keys(baubles).length <= 32, {
    message: 'A tree holds at most 32 baubles',
  })

const xmasTree: FastifyPluginAsync = async (fastify, _opts): Promise<void> => {
  fastify.addHook('onRequest', fastify.authenticate)

  fastify.get('/', async function (request, _reply) {
    const tree = await fastify.prisma.xmasTree.findUnique({
      select: { baubles: true },
      where: { profileId: request.user.id },
    })

    const parsed = baublesSchema.safeParse(tree?.baubles ?? {})
    return { baubles: parsed.success ? parsed.data : {} }
  })

  fastify.withTypeProvider<ZodTypeProvider>().put(
    '/',
    {
      schema: {
        body: z.object({ baubles: baublesSchema }),
      },
    },
    async function (request, _reply) {
      const { baubles } = request.body

      const tree = await fastify.prisma.xmasTree.upsert({
        select: { baubles: true },
        where: { profileId: request.user.id },
        create: { profileId: request.user.id, baubles },
        update: { baubles },
      })

      return { baubles: tree.baubles }
    },
  )
}

export default xmasTree
