import { z } from 'zod'

import { PROVIDER_NAMES } from './ai.helper.js'

export const providerParamsSchema = z.object({
  provider: z.enum(PROVIDER_NAMES),
})

// a secret key as copied from the provider's site; its form is checked by provider
export const aiKeySchema = z.object({
  key: z.string().trim().min(1),
})
