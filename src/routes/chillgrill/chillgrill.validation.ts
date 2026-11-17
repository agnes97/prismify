import { ChillgrillCategory, ChillgrillSourceType } from '@prisma/client'
import { z } from 'zod'

/** each category by the name it goes by in JSON */
export const CATEGORIES = {
  typescript: ChillgrillCategory.TYPESCRIPT,
  javascript: ChillgrillCategory.JAVASCRIPT,
  'system-design': ChillgrillCategory.SYSTEM_DESIGN,
  management: ChillgrillCategory.MANAGEMENT,
  git: ChillgrillCategory.GIT,
} as const satisfies Record<string, ChillgrillCategory>

export type CategoryName = keyof typeof CATEGORIES

/** each kind of source by the name it goes by in JSON */
export const SOURCE_TYPES = {
  webpage: ChillgrillSourceType.WEBPAGE,
  book: ChillgrillSourceType.BOOK,
  chapter: ChillgrillSourceType.CHAPTER,
} as const satisfies Record<string, ChillgrillSourceType>

export type SourceTypeName = keyof typeof SOURCE_TYPES

const categoryNames = Object.keys(CATEGORIES) as [
  CategoryName,
  ...CategoryName[],
]

const text = (max: number) => z.string().trim().min(1).max(max)

// where the answer comes from: a webpage by its address, or a book, or one of its chapters
export const sourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('webpage'),
    url: z.string().trim().url().max(2000),
    title: text(300).optional(),
  }),
  z.object({
    type: z.literal('book'),
    title: text(300),
    author: text(200).optional(),
  }),
  z.object({
    type: z.literal('chapter'),
    title: text(300),
    author: text(200).optional(),
    chapter: text(300),
  }),
])

export const questionSchema = z.object({
  category: z.enum(categoryNames),
  question: text(500),
  answer: z.string().trim().min(20).max(6000),
  source: sourceSchema,
})

export const idParamsSchema = z.object({ id: z.string().uuid() })

export const senseiSchema = z.object({
  // the whole conversation about the question so far, ending with the candidate's latest answer
  turns: z
    .array(
      z.object({
        role: z.enum(['candidate', 'sensei']),
        text: text(4000),
      }),
    )
    .min(1)
    .max(80)
    .refine((turns) => turns[turns.length - 1]?.role === 'candidate', {
      message: 'The last turn has to be the candidate’s answer',
    }),
  covered: z.array(z.number().int().min(0)).max(20).default([]),
})
