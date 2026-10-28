// Works out the spine colour again for every cover already in Vercel Blob,
// after the way it is worked out has changed. Safe to run again.
//
//   pnpm library:recolor-covers                                         # against .env
//   pnpm tsc && pnpm dotenv -e .env.vercel -- node dist/scripts/recolor-covers.js
import { PrismaClient } from '@prisma/client'

import { coverColor, isMirrored } from '../src/routes/library/library.cover.js'

const prisma = new PrismaClient()

const books = await prisma.libraryBook.findMany({
  select: { id: true, title: true, coverUrl: true, coverColor: true },
  where: { coverUrl: { not: null } },
  orderBy: { createdAt: 'asc' },
})

const mirrored = books.filter(
  (book) => book.coverUrl && isMirrored(book.coverUrl),
)
console.log(`${mirrored.length} of ${books.length} covers to recolour`)

let failed = 0
for (const book of mirrored) {
  if (!book.coverUrl) continue

  try {
    const response = await fetch(book.coverUrl, {
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error(`${response.status}`)

    const color = await coverColor(Buffer.from(await response.arrayBuffer()))
    await prisma.libraryBook.update({
      where: { id: book.id },
      data: { coverColor: color },
    })
    console.log(`✓ ${book.title} ${book.coverColor} → ${color}`)
  } catch (error) {
    failed++
    console.log(`✗ ${book.title} (${String(error)})`)
  }
}

console.log(`${mirrored.length - failed} recoloured, ${failed} failed`)
await prisma.$disconnect()
