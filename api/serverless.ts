// Require the framework
import Fastify, { RouteHandler } from 'fastify'

// Instantiate Fastify with some config
const app = Fastify({
  logger: true,
})

// Register your application as a normal plugin.
void app.register(import('../src/app.js'))

// Create a request handler for the serverless function
const handler: RouteHandler = async (request, reply) => {
  await app.ready()
  app.server.emit('request', request, reply)
}

export default handler
