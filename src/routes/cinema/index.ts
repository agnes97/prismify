import { randomUUID } from 'node:crypto'
import { CinemaKind, CinemaState, Prisma } from '@prisma/client'
import { FastifyPluginAsync } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { parseRead } from '../library/library.helper.js'

import {
  entrySelect,
  fetchTitle,
  isAhead,
  linkedIds,
  nextEpisode,
  parseTitleId,
  searchTitles,
  titleSelect,
  TmdbError,
  toEntry,
} from './cinema.helper.js'
import {
  entryEditSchema,
  entrySchema,
  linkSchema,
  nextSchema,
  preferenceSchema,
  searchSchema,
  VIEWS,
} from './cinema.validation.js'

const profileSelect = {
  id: true,
  name: true,
  avatar: true,
} satisfies Prisma.ProfileSelect

const linkSelect = {
  id: true,
  fromId: true,
  acceptedAt: true,
  createdAt: true,
  From: { select: profileSelect },
  To: { select: profileSelect },
} satisfies Prisma.CinemaLinkSelect

type LinkRecord = Prisma.CinemaLinkGetPayload<{ select: typeof linkSelect }>

/** A link as one of its two people sees it: who is on the other end, and whether they sent it. */
function toLink({ fromId, From, To, ...link }: LinkRecord, profileId: string) {
  const sent = fromId === profileId
  return { ...link, sent, person: sent ? To : From }
}

/**
 * When a title in `state` was watched, stored as a year and maybe a day, or
 * null for a day that doesn't exist or is in the future. A title not watched
 * has none, and one watched without saying when was watched today.
 */
function watchedFields(state: CinemaState, watched: string | undefined) {
  if (state !== CinemaState.WATCHED) {
    return { watchedYear: null, watchedDate: null }
  }
  const parsed = parseRead(watched ?? new Date().toISOString().slice(0, 10))
  return (
    parsed && { watchedYear: parsed.readYear, watchedDate: parsed.readDate }
  )
}

const badWatched = {
  message: 'The day you watched it must be a real day, not in the future',
}

const cinema: FastifyPluginAsync = async (fastify, _opts): Promise<void> => {
  const tmdbToken = fastify.config.TMDB_TOKEN || undefined
  const noTmdb = { message: 'Titles can’t be looked up right now' }

  // visitors can search too
  fastify.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.url.endsWith('/search')) return
    return fastify.authenticate(request, reply)
  })

  /**
   * The entries a change to entry `id` applies to: that one, which must be
   * mine, or with `together` every entry of its together-group, which must
   * include mine. Returns the status and message to refuse with otherwise.
   */
  async function targetsOf(id: string, profileId: string, together: boolean) {
    const entry = await fastify.prisma.cinemaEntry.findUnique({
      select: {
        id: true,
        viewerId: true,
        togetherId: true,
        state: true,
        season: true,
        episode: true,
        Title: { select: { kind: true, genres: true, episodeCounts: true } },
      },
      where: { id },
    })
    if (!entry) {
      return { status: 404, message: 'Entry not found' } as const
    }
    if (!together) {
      return entry.viewerId === profileId
        ? { entry, targets: [entry] }
        : ({
            status: 403,
            message: 'Only the viewer can change this entry',
          } as const)
    }
    if (!entry.togetherId) {
      return {
        status: 400,
        message: 'Nobody is watching this together with you',
      } as const
    }

    const group = await fastify.prisma.cinemaEntry.findMany({
      select: {
        id: true,
        viewerId: true,
        state: true,
        season: true,
        episode: true,
      },
      where: { togetherId: entry.togetherId },
    })
    return group.some((member) => member.viewerId === profileId)
      ? { entry, targets: group }
      : ({
          status: 403,
          message: 'Only the people watching it together can change it',
        } as const)
  }

  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/search',
    {
      schema: {
        querystring: searchSchema,
      },
    },
    async function (request, reply) {
      // visitors can search too, and only see whose shelf a title is on when logged in
      if (!tmdbToken) return reply.status(503).send(noTmdb)

      let results
      try {
        results = await searchTitles(tmdbToken, request.query.q)
      } catch (error) {
        if (error instanceof TmdbError) {
          return reply.status(error.status).send({ message: error.message })
        }
        throw error
      }

      let profileId: string | null = null
      try {
        await request.jwtVerify()
        profileId = request.user.id
      } catch {
        return results
      }

      const viewers = [
        profileId,
        ...(await linkedIds(fastify.prisma, profileId)),
      ]
      const entries = await fastify.prisma.cinemaEntry.findMany({
        select: {
          titleId: true,
          state: true,
          watchedYear: true,
          Viewer: { select: profileSelect },
        },
        where: {
          titleId: { in: results.map((result) => result.id) },
          viewerId: { in: viewers },
        },
      })

      return results.map((result) => ({
        ...result,
        on: entries
          .filter((entry) => entry.titleId === result.id)
          .map(({ Viewer, state, watchedYear }) => ({
            viewer: Viewer,
            state,
            watchedYear,
          })),
      }))
    },
  )

  fastify.get('/entries', async function (request, _reply) {
    // mine and those of everyone linked with me
    const viewers = [
      request.user.id,
      ...(await linkedIds(fastify.prisma, request.user.id)),
    ]
    const entries = await fastify.prisma.cinemaEntry.findMany({
      select: entrySelect,
      where: { viewerId: { in: viewers } },
      orderBy: { createdAt: 'desc' },
    })

    return entries.map(toEntry)
  })

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/entries',
    {
      schema: {
        body: entrySchema,
      },
    },
    async function (request, reply) {
      const me = request.user.id
      const { id, state, season, episode, watched } = request.body
      const viewers = [...new Set(request.body.viewers ?? [me])]

      const linked = await linkedIds(fastify.prisma, me)
      if (viewers.some((viewer) => viewer !== me && !linked.includes(viewer))) {
        return reply.status(403).send({
          message: 'Titles can only go on your own shelf or a linked one',
        })
      }

      const isSeries = parseTitleId(id)?.kind === CinemaKind.TV
      if (!isSeries && (season !== undefined || episode !== undefined)) {
        return reply.status(400).send({ message: 'Only series have episodes' })
      }
      if ((season === undefined) !== (episode === undefined)) {
        return reply.status(400).send({
          message: 'Progress needs both the season and the episode',
        })
      }

      const when = watchedFields(state, watched)
      if (!when) return reply.status(400).send(badWatched)

      const stored = await fastify.prisma.cinemaTitle.findUnique({
        select: { id: true },
        where: { id },
      })

      // fetched outside the transaction, and only for a title not on any shelf yet
      let title: Awaited<ReturnType<typeof fetchTitle>> | null = null
      if (!stored) {
        if (!tmdbToken) return reply.status(503).send(noTmdb)
        try {
          title = await fetchTitle(tmdbToken, id)
        } catch (error) {
          if (error instanceof TmdbError) {
            return reply.status(error.status).send({ message: error.message })
          }
          throw error
        }
      }

      // a series being watched starts before its first episode
      const progress =
        isSeries && state === CinemaState.WATCHING
          ? { season: season ?? 1, episode: episode ?? 0 }
          : isSeries && state === CinemaState.WATCHED
            ? { season: season ?? null, episode: episode ?? null }
            : { season: null, episode: null }
      const togetherId = viewers.length > 1 ? randomUUID() : null

      const entries = await fastify.prisma.$transaction(async (transaction) => {
        if (title) {
          await transaction.cinemaTitle.upsert({
            where: { id },
            create: title,
            update: {},
          })
        }

        // a title already on someone's shelf moves to where it was added now
        return Promise.all(
          viewers.map((viewerId) =>
            transaction.cinemaEntry.upsert({
              select: entrySelect,
              where: { viewerId_titleId: { viewerId, titleId: id } },
              create: {
                titleId: id,
                viewerId,
                addedById: me,
                state,
                ...progress,
                ...when,
                togetherId,
              },
              update: {
                state,
                ...progress,
                ...when,
                ...(togetherId && { togetherId }),
              },
            }),
          ),
        )
      })

      return reply.status(201).send(entries.map(toEntry))
    },
  )

  fastify.withTypeProvider<ZodTypeProvider>().patch(
    '/entries/:id',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: entryEditSchema,
      },
    },
    async function (request, reply) {
      const { state, season, episode, watched, mainGenre, together } =
        request.body

      const found = await targetsOf(
        request.params.id,
        request.user.id,
        together ?? false,
      )
      if (!found.targets) {
        return reply.status(found.status).send({ message: found.message })
      }
      const { entry, targets } = found
      const isSeries = entry.Title.kind === CinemaKind.TV

      if (mainGenre && !entry.Title.genres.includes(mainGenre)) {
        return reply
          .status(400)
          .send({ message: 'The main genre must be one of the title’s' })
      }
      if (!isSeries && season !== undefined) {
        return reply.status(400).send({ message: 'Only series have episodes' })
      }

      const finalState = state ?? entry.state
      if (watched !== undefined && finalState !== CinemaState.WATCHED) {
        return reply
          .status(400)
          .send({ message: 'Only a watched title has a day it was watched' })
      }
      // moving it, or changing when it was watched, sets the day again
      const when =
        state !== undefined || watched !== undefined
          ? watchedFields(finalState, watched)
          : {}
      if (!when) return reply.status(400).send(badWatched)

      const entries = await fastify.prisma.$transaction((transaction) =>
        Promise.all(
          targets.map((target) => {
            // a series moved to Watching starts before its first episode, and one
            // moved back to Upcoming forgets how far it got
            const progress =
              season !== undefined
                ? { season, episode: episode ?? 0 }
                : isSeries && state === CinemaState.WATCHING
                  ? { season: target.season ?? 1, episode: target.episode ?? 0 }
                  : state === CinemaState.UPCOMING
                    ? { season: null, episode: null }
                    : {}

            return transaction.cinemaEntry.update({
              select: entrySelect,
              where: { id: target.id },
              data: {
                ...(state !== undefined && { state }),
                ...progress,
                ...when,
                ...(mainGenre !== undefined && { mainGenre }),
              },
            })
          }),
        ),
      )

      return entries.map(toEntry)
    },
  )

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/entries/:id/next',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: nextSchema,
      },
    },
    async function (request, reply) {
      const entry = await fastify.prisma.cinemaEntry.findUnique({
        select: { togetherId: true },
        where: { id: request.params.id },
      })
      // a together entry moves everyone watching it unless told otherwise
      const together = request.body?.together ?? !!entry?.togetherId

      const found = await targetsOf(
        request.params.id,
        request.user.id,
        together,
      )
      if (!found.targets) {
        return reply.status(found.status).send({ message: found.message })
      }
      const { Title, ...watching } = found.entry
      if (Title.kind !== CinemaKind.TV) {
        return reply.status(400).send({ message: 'Only series have episodes' })
      }

      const next = nextEpisode(
        watching.season ?? 1,
        watching.episode ?? 0,
        Title.episodeCounts,
      )
      if (!next) {
        return reply.status(400).send({
          message: 'That was the last episode out, move it to Watched',
        })
      }

      const entries = await fastify.prisma.$transaction((transaction) =>
        Promise.all(
          found.targets.map((target) => {
            // someone who watched further alone stays where they are
            const theirs = {
              season: target.season ?? 1,
              episode: target.episode ?? 0,
            }
            return transaction.cinemaEntry.update({
              select: entrySelect,
              where: { id: target.id },
              data: {
                ...(isAhead(theirs, next) ? theirs : next),
                ...(target.state === CinemaState.UPCOMING && {
                  state: CinemaState.WATCHING,
                }),
              },
            })
          }),
        ),
      )

      return entries.map(toEntry)
    },
  )

  fastify.withTypeProvider<ZodTypeProvider>().delete(
    '/entries/:id',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async function (request, reply) {
      const entry = await fastify.prisma.cinemaEntry.findUnique({
        select: { viewerId: true, titleId: true, togetherId: true },
        where: { id: request.params.id },
      })

      if (!entry) {
        return reply.status(404).send({ message: 'Entry not found' })
      }
      // only your own entries can be taken off the shelf
      if (entry.viewerId !== request.user.id) {
        return reply
          .status(403)
          .send({ message: 'Only the viewer can remove this title' })
      }

      await fastify.prisma.$transaction(async (transaction) => {
        await transaction.cinemaEntry.delete({
          where: { id: request.params.id },
        })

        // the one left of a pair isn't watching it together anymore
        if (entry.togetherId) {
          const left = await transaction.cinemaEntry.count({
            where: { togetherId: entry.togetherId },
          })
          if (left === 1) {
            await transaction.cinemaEntry.updateMany({
              where: { togetherId: entry.togetherId },
              data: { togetherId: null },
            })
          }
        }

        // the title goes too once nobody has it on a shelf
        await transaction.cinemaTitle.deleteMany({
          where: { id: entry.titleId, Entries: { none: {} } },
        })
      })

      return reply.status(204).send()
    },
  )

  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/titles/:id/refresh',
    {
      schema: {
        params: z.object({ id: z.string() }),
      },
    },
    async function (request, reply) {
      // for a fresh trailer, status and seasons; only titles on shelves I can see
      const viewers = [
        request.user.id,
        ...(await linkedIds(fastify.prisma, request.user.id)),
      ]
      const title = await fastify.prisma.cinemaTitle.findFirst({
        select: { id: true, tvmazeId: true },
        where: {
          id: request.params.id,
          Entries: { some: { viewerId: { in: viewers } } },
        },
      })
      if (!title) {
        return reply.status(404).send({ message: 'Title not found' })
      }
      if (!tmdbToken) return reply.status(503).send(noTmdb)

      let fresh
      try {
        fresh = await fetchTitle(tmdbToken, title.id, title)
      } catch (error) {
        if (error instanceof TmdbError) {
          return reply.status(error.status).send({ message: error.message })
        }
        throw error
      }

      const { id: _id, ...data } = fresh
      return fastify.prisma.cinemaTitle.update({
        select: titleSelect,
        where: { id: title.id },
        data,
      })
    },
  )

  fastify.get('/links', async function (request, _reply) {
    const links = await fastify.prisma.cinemaLink.findMany({
      select: linkSelect,
      where: { OR: [{ fromId: request.user.id }, { toId: request.user.id }] },
      orderBy: { createdAt: 'asc' },
    })

    return links.map((link) => toLink(link, request.user.id))
  })

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/links',
    {
      schema: {
        body: linkSchema,
      },
    },
    async function (request, reply) {
      const me = request.user.id
      const user = await fastify.prisma.user.findFirst({
        select: { profile: { select: { id: true } } },
        where: { email: { equals: request.body.email, mode: 'insensitive' } },
      })
      const them = user?.profile?.id

      if (!them) {
        return reply
          .status(404)
          .send({ message: 'Nobody has an account with that email' })
      }
      if (them === me) {
        return reply
          .status(400)
          .send({ message: 'Your shelf is already your own' })
      }

      const existing = await fastify.prisma.cinemaLink.findFirst({
        select: { id: true, fromId: true, acceptedAt: true },
        where: {
          OR: [
            { fromId: me, toId: them },
            { fromId: them, toId: me },
          ],
        },
      })
      if (existing?.acceptedAt) {
        return reply
          .status(409)
          .send({ message: 'Your shelves are already linked' })
      }
      if (existing?.fromId === me) {
        return reply
          .status(409)
          .send({ message: 'You’ve already invited them' })
      }

      // inviting someone who invited you accepts theirs
      const link = existing
        ? await fastify.prisma.cinemaLink.update({
            select: linkSelect,
            where: { id: existing.id },
            data: { acceptedAt: new Date() },
          })
        : await fastify.prisma.cinemaLink.create({
            select: linkSelect,
            data: { fromId: me, toId: them },
          })

      return reply.status(existing ? 200 : 201).send(toLink(link, me))
    },
  )

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/links/:id/accept',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async function (request, reply) {
      const link = await fastify.prisma.cinemaLink.findUnique({
        select: { toId: true, acceptedAt: true },
        where: { id: request.params.id },
      })

      if (!link) {
        return reply.status(404).send({ message: 'Invitation not found' })
      }
      if (link.toId !== request.user.id) {
        return reply
          .status(403)
          .send({ message: 'Only the one invited can accept' })
      }

      const accepted = await fastify.prisma.cinemaLink.update({
        select: linkSelect,
        where: { id: request.params.id },
        data: { acceptedAt: link.acceptedAt ?? new Date() },
      })

      return toLink(accepted, request.user.id)
    },
  )

  fastify.withTypeProvider<ZodTypeProvider>().delete(
    '/links/:id',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async function (request, reply) {
      // either of the two can unlink, or take back or turn down an invitation
      const link = await fastify.prisma.cinemaLink.findUnique({
        select: { fromId: true, toId: true },
        where: { id: request.params.id },
      })

      if (!link) {
        return reply.status(404).send({ message: 'Link not found' })
      }
      if (link.fromId !== request.user.id && link.toId !== request.user.id) {
        return reply
          .status(403)
          .send({ message: 'Only the two linked can unlink' })
      }

      await fastify.prisma.cinemaLink.delete({
        where: { id: request.params.id },
      })

      return reply.status(204).send()
    },
  )

  fastify.get('/preference', async function (request, _reply) {
    const preference = await fastify.prisma.cinemaPreference.findUnique({
      select: { view: true },
      where: { profileId: request.user.id },
    })
    const view = preference?.view ?? 'everyone'

    // someone unlinked since leaves everyone in view
    const isPerson = !(VIEWS as readonly string[]).includes(view)
    if (
      isPerson &&
      !(await linkedIds(fastify.prisma, request.user.id)).includes(view)
    ) {
      return { view: 'everyone' }
    }

    return { view }
  })

  fastify.withTypeProvider<ZodTypeProvider>().put(
    '/preference',
    {
      schema: {
        body: preferenceSchema,
      },
    },
    async function (request, reply) {
      const { view } = request.body

      const isPerson = !(VIEWS as readonly string[]).includes(view)
      if (
        isPerson &&
        !(await linkedIds(fastify.prisma, request.user.id)).includes(view)
      ) {
        return reply
          .status(400)
          .send({ message: 'Only a linked person’s shelf can be shown' })
      }

      return fastify.prisma.cinemaPreference.upsert({
        select: { view: true },
        where: { profileId: request.user.id },
        create: { profileId: request.user.id, view },
        update: { view },
      })
    },
  )
}

export default cinema
