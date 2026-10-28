import { Prisma } from '@prisma/client'

const OPEN_LIBRARY_URL = 'https://openlibrary.org'
const DAY = 24 * 60 * 60 * 1000

const profileSelect = {
  id: true,
  name: true,
  avatar: true,
} satisfies Prisma.ProfileSelect

export const bookSelect = {
  id: true,
  title: true,
  authors: true,
  year: true,
  pages: true,
  coverUrl: true,
  coverColor: true,
  spineUrl: true,
  spineColor: true,
  spineRatio: true,
  isbn: true,
  description: true,
  series: true,
} satisfies Prisma.LibraryBookSelect

export const readingSelect = {
  id: true,
  readYear: true,
  readDate: true,
  createdAt: true,
  Book: { select: bookSelect },
  ReadBy: { select: profileSelect },
  AddedBy: { select: profileSelect },
} satisfies Prisma.LibraryReadingSelect

type ReadingRecord = Prisma.LibraryReadingGetPayload<{
  select: typeof readingSelect
}>

export function toReading({
  readYear,
  readDate,
  Book,
  ReadBy,
  AddedBy,
  ...reading
}: ReadingRecord) {
  return {
    ...reading,
    read: readDate ? readDate.toISOString().slice(0, 10) : String(readYear),
    book: Book,
    readBy: ReadBy,
    addedBy: AddedBy,
  }
}

/**
 * Splits `YYYY-MM-DD` or `YYYY` into what is stored, or returns null for a day
 * that doesn't exist, one in the future or a year before 1900.
 */
export function parseRead(
  read: string,
): { readYear: number; readDate: Date | null } | null {
  const readYear = Number(read.slice(0, 4))
  // a day of slack, so a reader east of UTC can add a book read today
  const tomorrow = new Date(Date.now() + DAY)

  if (readYear < 1900 || readYear > tomorrow.getUTCFullYear()) return null
  if (read.length === 4) return { readYear, readDate: null }

  const readDate = new Date(read)
  if (
    Number.isNaN(readDate.getTime()) ||
    readDate.toISOString().slice(0, 10) !== read ||
    readDate > tomorrow
  ) {
    return null
  }

  return { readYear, readDate }
}

const descriptionText = (value: unknown): string | null => {
  if (typeof value === 'string') return value
  if (
    value &&
    typeof value === 'object' &&
    'value' in value &&
    typeof value.value === 'string'
  ) {
    return value.value
  }
  return null
}

/** The work's description from Open Library, or null when it has none or can't be reached. */
export async function fetchDescription(id: string): Promise<string | null> {
  try {
    const response = await fetch(`${OPEN_LIBRARY_URL}/works/${id}.json`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) return null

    const work = (await response.json()) as { description?: unknown }
    return descriptionText(work.description)?.trim() || null
  } catch {
    return null
  }
}
