// Copies every library cover still on Open Library into Vercel Blob, with its
// colour for the spine. Safe to run again: mirrored books are skipped.
//
//   pnpm library:mirror-covers                                          # against .env
//   pnpm tsc && pnpm dotenv -e .env.vercel -- node dist/scripts/mirror-covers.js
import { PrismaClient } from '@prisma/client'

import { isMirrored, mirrorCover } from '../src/routes/library/library.cover.js'

const PAUSE = 500

const token = process.env['BLOB_READ_WRITE_TOKEN']
if (!token) {
  console.error('BLOB_READ_WRITE_TOKEN is not set')
  process.exit(1)
}

const prisma = new PrismaClient()

const books = await prisma.libraryBook.findMany({
  select: { id: true, title: true, coverUrl: true },
  where: { coverUrl: { not: null } },
  orderBy: { createdAt: 'asc' },
})

const pending = books.filter(
  (book) => book.coverUrl && !isMirrored(book.coverUrl),
)
console.log(`${pending.length} of ${books.length} covers to mirror`)

let failed = 0
for (const book of pending) {
  if (!book.coverUrl) continue
  const cover = await mirrorCover(token, book.id, book.coverUrl)

  if (cover) {
    await prisma.libraryBook.update({ where: { id: book.id }, data: cover })
    console.log(`✓ ${book.title}`)
  } else {
    failed++
    console.log(`✗ ${book.title} (${book.coverUrl})`)
  }

  // Open Library asks to be gentle with its covers
  await new Promise((resolve) => setTimeout(resolve, PAUSE))
}

console.log(`${pending.length - failed} mirrored, ${failed} failed`)
await prisma.$disconnect()
