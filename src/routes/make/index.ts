import { FastifyPluginAsync } from 'fastify'
import axios from 'axios'

const doggoTime: FastifyPluginAsync = async (fastify, _opts): Promise<void> => {
  fastify.get('/doggo-time', async function (request, _reply) {
    await axios.post(
      'https://hook.eu2.make.com/jg3b9xpstdq8r305qoi737ba1h9c9hy6',
      {
        name: 'Henry',
        request: request.body,
      },
    )
  })
}

export default doggoTime
