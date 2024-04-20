import { FastifyPluginAsync } from 'fastify'

import packageJSON from '../../package.json' with { type: 'json' }

const root: FastifyPluginAsync = async (fastify, _opts): Promise<void> => {
  fastify.get('/', function (_request, _reply) {
    return {
      application: packageJSON.name,
      version: packageJSON.version,
    }
  })
}

export default root
