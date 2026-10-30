import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { AiProvider, type PrismaClient } from '@prisma/client'
import OpenAI from 'openai'

/** each provider by the name it goes by in URLs and JSON, e.g. /ai/keys/openai */
export const PROVIDERS = {
  openai: AiProvider.OPENAI,
} as const satisfies Record<string, AiProvider>

export type ProviderName = keyof typeof PROVIDERS

export const PROVIDER_NAMES = Object.keys(PROVIDERS) as [
  ProviderName,
  ...ProviderName[],
]

/** reads book pages, searches the web and looks at photos */
export const OPENAI_TEXT_MODEL = 'gpt-5.5'
/** tells which found photos show the spine, a plain look that needs no big model */
export const OPENAI_LOOK_MODEL = 'gpt-5.4-mini'
/** paints the spines */
export const OPENAI_IMAGE_MODEL = 'gpt-image-2'

const CIPHER = 'aes-256-gcm'

/** The secret that seals the keys, or null when it is missing or not 32 bytes. */
export function keysSecret(secret: string | undefined): Buffer | null {
  const key = Buffer.from(secret ?? '', 'base64')
  return key.length === 32 ? key : null
}

/** Seals an API key as iv.tag.sealed, each base64, so the database never holds it bare. */
export function sealKey(secret: Buffer, apiKey: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv(CIPHER, secret, iv)
  const sealed = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), sealed]
    .map((part) => part.toString('base64'))
    .join('.')
}

export function openKey(secret: Buffer, cipher: string): string {
  const [iv, tag, sealed] = cipher
    .split('.')
    .map((part) => Buffer.from(part, 'base64'))
  if (!iv || !tag || !sealed) throw new Error('Malformed sealed key')

  const decipher = createDecipheriv(CIPHER, secret, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(sealed), decipher.final()]).toString(
    'utf8',
  )
}

/**
 * The reader's own keys that still open, by provider. One that no longer
 * opens, as when AI_KEYS_SECRET was changed, is let go, so the reader is asked
 * to connect again instead of meeting an error.
 */
export async function readersKeys(
  prisma: PrismaClient,
  secret: Buffer,
  userId: string,
  provider?: AiProvider,
): Promise<Map<AiProvider, { apiKey: string; hint: string }>> {
  const stored = await prisma.aiKey.findMany({
    select: { provider: true, cipher: true, hint: true },
    where: { userId, ...(provider && { provider }) },
  })

  const keys = new Map<AiProvider, { apiKey: string; hint: string }>()
  for (const { provider, cipher, hint } of stored) {
    try {
      keys.set(provider, { apiKey: openKey(secret, cipher), hint })
    } catch {
      await prisma.aiKey.deleteMany({ where: { userId, provider } })
    }
  }
  return keys
}

/**
 * Checks a key with its provider by a cheap call that fails at once on a wrong
 * or revoked one, returning what to tell the reader when it is refused.
 */
export async function keyProblem(
  provider: AiProvider,
  apiKey: string,
): Promise<string | null> {
  switch (provider) {
    case AiProvider.OPENAI:
      if (!/^sk-[\w-]{20,}$/.test(apiKey)) {
        return 'An OpenAI key starts with sk-'
      }
      try {
        await new OpenAI({ apiKey, maxRetries: 0 }).models.list()
        return null
      } catch (error) {
        return openaiProblem(error)
      }
  }
}

/** An OpenAI client on the reader's own key, or null when they haven't connected one. */
export async function openaiFor(
  prisma: PrismaClient,
  secret: Buffer,
  userId: string,
): Promise<OpenAI | null> {
  const key = (
    await readersKeys(prisma, secret, userId, AiProvider.OPENAI)
  ).get(AiProvider.OPENAI)
  if (!key) return null

  // the long work runs in the background at OpenAI, so each call is quick and
  // has to end well inside the minute a Vercel function may run
  return new OpenAI({
    apiKey: key.apiKey,
    timeout: 20_000,
    maxRetries: 1,
  })
}

const MINUTE = 60 * 1000
/**
 * how many calls a reader may make on each of their keys in each window, far
 * more than drawing spines by hand takes, so a stolen login can only spend a
 * little
 */
const ALLOWANCES = [
  { within: 10 * MINUTE, calls: 10, wait: 'in a few minutes' },
  { within: 24 * 60 * MINUTE, calls: 60, wait: 'tomorrow' },
]
const KEPT_FOR = 24 * 60 * MINUTE

/**
 * Counts a call on the reader's key against their allowance with that
 * provider, or returns what to tell them when it is used up.
 */
export async function useAllowance(
  prisma: PrismaClient,
  userId: string,
  provider: AiProvider,
): Promise<string | null> {
  const now = Date.now()
  for (const { within, calls, wait } of ALLOWANCES) {
    const made = await prisma.aiCall.count({
      where: { userId, provider, createdAt: { gte: new Date(now - within) } },
    })
    if (made >= calls) {
      return `That’s a lot of spines at once, try again ${wait}`
    }
  }

  await prisma.$transaction([
    prisma.aiCall.create({ data: { userId, provider } }),
    // older ones no longer count against anything
    prisma.aiCall.deleteMany({
      where: { userId, createdAt: { lt: new Date(now - KEPT_FOR) } },
    }),
  ])
  return null
}

/** What to tell the reader when OpenAI turns a call down. */
export function openaiProblem(error: unknown): string {
  if (error instanceof OpenAI.AuthenticationError) {
    return 'OpenAI doesn’t accept that key, it may have been revoked'
  }
  if (error instanceof OpenAI.PermissionDeniedError) {
    return 'That key isn’t allowed to use the models, give it All permissions'
  }
  if (error instanceof OpenAI.RateLimitError) {
    return error.code === 'insufficient_quota'
      ? 'Your OpenAI account has no credit, add some under Settings → Billing'
      : 'OpenAI is busy, try again in a minute'
  }
  if (error instanceof OpenAI.APIError) {
    return error.message
  }
  return 'OpenAI can’t be reached, try again'
}
