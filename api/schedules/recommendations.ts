import { PrismaClient } from '@prisma/client'
import { handleSchedule } from '@vercel/schedules'

import { scanRecommendations } from '../../src/routes/cinema/cinema.helper.js'

// Vercel Schedules, every Sunday, for everyone with shelves. Private: only
// Vercel's scheduler can call it. A run arriving twice just looks again.
export const POST = handleSchedule(async ({ name, executionId }) => {
  const token = process.env['TMDB_TOKEN']
  // thrown, it shows as a failed run in the schedule's history
  if (!token) throw new Error('TMDB_TOKEN is not set')

  const prisma = new PrismaClient()
  try {
    await scanRecommendations(prisma, token)
    console.log(`${name} ${executionId}: recommendations scanned`)
  } finally {
    await prisma.$disconnect()
  }
})
