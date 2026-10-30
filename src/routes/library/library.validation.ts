import { z } from 'zod'

import { isOpenLibraryCover } from './library.cover.js'

// only Open Library's covers are fetched and mirrored
const openLibraryCover = z
  .string()
  .url()
  .refine(isOpenLibraryCover, { message: 'Not an Open Library cover' })

// An Open Library search result, as the library's add form picked it
export const bookSchema = z.object({
  key: z.string().regex(/^\/works\/OL\d+W$/),
  title: z.string().trim().min(1),
  authors: z.array(z.string().trim().min(1)).default([]),
  year: z.number().int().optional(),
  pages: z.number().int().positive().optional(),
  coverUrl: openLibraryCover.optional(),
  isbn: z.string().optional(),
})

export const readingSchema = z.object({
  book: bookSchema,
  // the day it was read, or only the year when the day is forgotten
  read: z.string().regex(/^\d{4}(-\d{2}-\d{2})?$/),
})

// A correction to a book whose details came wrong from Open Library, e.g. a
// title in the language it was first published in
export const bookEditSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    authors: z.array(z.string().trim().min(1)).optional(),
    // an empty one clears it
    description: z.string().trim().nullable().optional(),
    // an empty one takes it out of its series, and its number with it
    series: z.string().trim().nullable().optional(),
    seriesNumber: z.number().positive().nullable().optional(),
  })
  .refine((edit) => Object.values(edit).some((value) => value !== undefined), {
    message: 'Nothing to change',
  })

// Another edition's cover picked from Open Library; an uploaded photo comes as
// multipart instead, which leaves the body null
export const coverPickSchema = z
  .object({ coverUrl: openLibraryCover })
  .nullish()

// A photo found on the web to draw the spine after; the reader's own photo
// comes as multipart instead, which leaves the body null
export const spineDrawSchema = z
  .object({ imageUrl: z.string().url() })
  .nullish()

// a search or drawing running at OpenAI, by the id of the response running it
export const spineJobSchema = z.string().regex(/^resp_\w+$/)
