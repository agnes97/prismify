import { CinemaState } from '@prisma/client'
import { z } from 'zod'

const titleId = z.string().regex(/^(movie|tv):\d+$/)
// the day it was watched, or only the year when the day is forgotten
const watched = z.string().regex(/^\d{4}(-\d{2}-\d{2})?$/)
const season = z.number().int().min(1)
// 0 before the season's first
const episode = z.number().int().min(0)

export const searchSchema = z.object({
  q: z.string().trim().min(1),
})

// A title picked from the search, onto the shelves of the people watching it
export const entrySchema = z.object({
  id: titleId,
  state: z.nativeEnum(CinemaState),
  // the last episode watched, for a series being watched
  season: season.optional(),
  episode: episode.optional(),
  // for a watched title; today when left out
  watched: watched.optional(),
  // me or people linked with me; two or more watch it together
  viewers: z.array(z.string().uuid()).min(1).optional(),
})

export const entryEditSchema = z
  .object({
    state: z.nativeEnum(CinemaState).optional(),
    season: season.optional(),
    episode: episode.optional(),
    watched: watched.optional(),
    // one of the title's genres to style it by, or null for TMDB's first
    mainGenre: z.string().nullable().optional(),
    // the whole together-group's entries, not only mine
    together: z.boolean().optional(),
  })
  .refine(
    ({ together: _together, ...edit }) =>
      Object.values(edit).some((value) => value !== undefined),
    { message: 'Nothing to change' },
  )
  .refine(
    (edit) => (edit.season === undefined) === (edit.episode === undefined),
    {
      message: 'Progress needs both the season and the episode',
    },
  )

export const nextSchema = z
  .object({
    // the whole together-group, which is the default for a together entry
    together: z.boolean().optional(),
  })
  .nullish()

export const linkSchema = z.object({
  email: z.string().email(),
})

export const VIEWS = ['everyone', 'me', 'both', 'together'] as const

export const preferenceSchema = z.object({
  // a linked person's id shows their shelf alone
  view: z.union([z.enum(VIEWS), z.string().uuid()]),
})
