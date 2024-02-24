import { z } from 'zod'

const thumbnailSchema = z.object({
  url: z.string().url(),
})

const photoSchema = z.object({
  thumbnails: z.tuple([
    thumbnailSchema.extend({
      type: z.literal('thumb70x100'),
    }),
    thumbnailSchema.extend({
      type: z.literal('thumb150x210'),
    }),
    thumbnailSchema.extend({
      type: z.literal('thumb310x430'),
    }),
    thumbnailSchema.extend({
      type: z.literal('thumb428x624'),
    }),
    thumbnailSchema.extend({
      type: z.literal('thumb624x428'),
    }),
    thumbnailSchema.extend({
      type: z.literal('thumb364x428'),
    }),
  ]),
})

const userSchema = z.object({
  country_code: z.string(),
  last_loged_on_ts: z.coerce.date(),
})

export const itemSchema = z.object({
  id: z.coerce.bigint().positive(),
  photos: z.array(photoSchema).nonempty(),
  title: z.string(),
  description: z.string(),
  user: userSchema,
  price_numeric: z.coerce.number().positive().finite().safe(),
  currency: z.string(),
  url: z.string().url(),
  brand: z.string(),
  item_closing_action: z.literal('sold').nullable(),
  is_reserved: z.literal(0).or(z.literal(1)),
})

export type Item = z.infer<typeof itemSchema>
