import { z } from 'zod'

// An Open Library search result, as the library's add form picked it
export const bookSchema = z.object({
  key: z.string().regex(/^\/works\/OL\d+W$/),
  title: z.string().min(1),
  authors: z.array(z.string()).default([]),
  year: z.number().int().optional(),
  pages: z.number().int().positive().optional(),
  coverUrl: z.string().url().optional(),
  isbn: z.string().optional(),
})

export const readingSchema = z.object({
  book: bookSchema,
  // the day it was read, or only the year when the day is forgotten
  read: z.string().regex(/^\d{4}(-\d{2}-\d{2})?$/),
})
