import {
  CinemaKind,
  CinemaRecommendationKind,
  CinemaState,
  Prisma,
  type PrismaClient,
} from '@prisma/client'

const TMDB_URL = 'https://api.themoviedb.org/3'
const TMDB_IMAGES = 'https://image.tmdb.org/t/p'
const TVMAZE_URL = 'https://api.tvmaze.com'

const profileSelect = {
  id: true,
  name: true,
  avatar: true,
} satisfies Prisma.ProfileSelect

export const titleSelect = {
  id: true,
  kind: true,
  title: true,
  year: true,
  genres: true,
  originalLanguage: true,
  posterUrl: true,
  backdropUrl: true,
  overview: true,
  trailerKey: true,
  collection: true,
  collectionOrder: true,
  tvmazeId: true,
  imdbId: true,
  seasons: true,
  episodeCounts: true,
  status: true,
  seasonAirDates: true,
  released: true,
} satisfies Prisma.CinemaTitleSelect

const isoDay = (day: Date) => day.toISOString().slice(0, 10)

/** A title as the client gets it, its days as `YYYY-MM-DD`. */
export const toTitle = ({
  seasonAirDates,
  released,
  ...title
}: Prisma.CinemaTitleGetPayload<{ select: typeof titleSelect }>) => ({
  ...title,
  seasonAirDates: seasonAirDates.map(isoDay),
  released: released ? isoDay(released) : null,
})

const watchSelect = {
  id: true,
  season: true,
  watchedYear: true,
  watchedDate: true,
} satisfies Prisma.CinemaWatchSelect

export const entrySelect = {
  id: true,
  state: true,
  season: true,
  episode: true,
  togetherId: true,
  mainGenre: true,
  belovedAt: true,
  droppedAt: true,
  createdAt: true,
  updatedAt: true,
  Title: { select: titleSelect },
  Viewer: { select: profileSelect },
  AddedBy: { select: profileSelect },
  Watches: { select: watchSelect, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.CinemaEntrySelect

type EntryRecord = Prisma.CinemaEntryGetPayload<{
  select: typeof entrySelect
}>

/** A watch's day as `YYYY-MM-DD`, or only `YYYY` when the day is forgotten. */
const watchedOn = (watch: { watchedYear: number; watchedDate: Date | null }) =>
  watch.watchedDate
    ? watch.watchedDate.toISOString().slice(0, 10)
    : String(watch.watchedYear)

/** Where a watch sorts; one with only a year comes before the dated ones of its year. */
const watchRank = (watched: string) =>
  watched.length === 4 ? `${watched}-00-00` : watched

export function toEntry({
  Title,
  Viewer,
  AddedBy,
  Watches,
  ...entry
}: EntryRecord) {
  const watches = Watches.map(({ id, season, ...when }) => ({
    id,
    season,
    watched: watchedOn(when),
  })).sort((a, b) => watchRank(a.watched).localeCompare(watchRank(b.watched)))

  return {
    ...entry,
    // the latest watch
    watched: watches.at(-1)?.watched ?? null,
    watches,
    title: toTitle(Title),
    viewer: Viewer,
    addedBy: AddedBy,
  }
}

/**
 * The seasons of a series that moving it to Watched marks watched: every one
 * when it has no progress, else those up to where it got, the season it is
 * in only once an episode of it is watched.
 */
export function finishedSeasons(
  progress: { season: number | null; episode: number | null },
  title: { seasons: number | null; episodeCounts: number[] },
): number[] {
  const last =
    progress.season === null
      ? title.seasons ?? (title.episodeCounts.length || 1)
      : (progress.episode ?? 0) > 0
        ? progress.season
        : progress.season - 1
  return Array.from({ length: last }, (_, i) => i + 1)
}

/** Whether `season`·`episode` is the last episode of its season, by TMDB's count. */
export const endsSeason = (
  { season, episode }: { season: number; episode: number },
  episodeCounts: number[],
) => episode > 0 && episode === episodeCounts[season - 1]

/** The ids of everyone whose shelves are linked with the person's, both ways, once accepted. */
export async function linkedIds(
  prisma: PrismaClient,
  profileId: string,
): Promise<string[]> {
  const links = await prisma.cinemaLink.findMany({
    select: { fromId: true, toId: true },
    where: {
      acceptedAt: { not: null },
      OR: [{ fromId: profileId }, { toId: profileId }],
    },
  })
  return links.map(({ fromId, toId }) => (fromId === profileId ? toId : fromId))
}

/** `movie:603` or `tv:1399` split into what TMDB calls them, or null for anything else. */
export function parseTitleId(
  id: string,
): { kind: CinemaKind; tmdbId: number } | null {
  const match = /^(movie|tv):(\d+)$/.exec(id)
  if (!match?.[1] || !match[2]) return null
  return {
    kind: match[1] === 'movie' ? CinemaKind.MOVIE : CinemaKind.TV,
    tmdbId: Number(match[2]),
  }
}

/** Thrown when TMDB can't be reached or doesn't know the title, with the status to answer with. */
export class TmdbError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 502,
  ) {
    super(message)
  }
}

const unknownTitle = () => new TmdbError('TMDB doesn’t know that title', 404)
const unreachable = () => new TmdbError('TMDB can’t be reached right now', 502)

async function tmdb<T>(
  token: string,
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`${TMDB_URL}${path}`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }

  let response: Response
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    throw unreachable()
  }
  if (response.status === 404) throw unknownTitle()
  if (!response.ok) throw unreachable()
  return (await response.json()) as T
}

const image = (size: string, path: string | null | undefined) =>
  path ? `${TMDB_IMAGES}/${size}${path}` : null

const yearOf = (date: string | null | undefined) =>
  date ? Number(date.slice(0, 4)) || null : null

interface SearchResult {
  id: number
  media_type: 'movie' | 'tv' | 'person'
  title?: string
  name?: string
  release_date?: string
  first_air_date?: string
  poster_path?: string | null
}

/** Movies and series matching the query, the way TMDB ranks them, people left out. */
export async function searchTitles(token: string, query: string) {
  const { results } = await tmdb<{ results: SearchResult[] }>(
    token,
    '/search/multi',
    { query, include_adult: 'false' },
  )

  return results
    .filter((result) => result.media_type !== 'person')
    .map((result) => ({
      id: `${result.media_type}:${result.id}`,
      kind: result.media_type === 'movie' ? CinemaKind.MOVIE : CinemaKind.TV,
      title: result.title ?? result.name ?? '',
      year: yearOf(result.release_date ?? result.first_air_date),
      posterUrl: image('w342', result.poster_path),
    }))
}

interface Video {
  key: string
  site: string
  type: string
  official: boolean
}

interface Details {
  title?: string
  name?: string
  release_date?: string
  first_air_date?: string
  genres: { id: number; name: string }[]
  original_language?: string
  poster_path?: string | null
  backdrop_path?: string | null
  overview?: string
  status?: string
  imdb_id?: string | null
  belongs_to_collection?: { id: number; name: string } | null
  seasons?: {
    season_number: number
    episode_count: number
    air_date?: string | null
  }[]
  number_of_seasons?: number
  videos?: { results: Video[] }
  external_ids?: { imdb_id?: string | null; tvdb_id?: number | null }
}

/** The official YouTube trailer, else any trailer, else a teaser. */
function trailerKey(videos: Video[]): string | null {
  const youtube = videos.filter((video) => video.site === 'YouTube')
  const rank = (video: Video) =>
    (video.type === 'Trailer' ? 0 : video.type === 'Teaser' ? 2 : 4) +
    (video.official ? 0 : 1)
  const best = youtube
    .filter((video) => rank(video) < 4)
    .sort((a, b) => rank(a) - rank(b))[0]
  return best?.key ?? null
}

interface Part {
  id: number
  title: string
  release_date?: string
  poster_path?: string | null
}

/** The films of a franchise by release, unreleased ones without a date last. */
async function collectionParts(
  token: string,
  collectionId: number,
): Promise<Part[]> {
  const { parts } = await tmdb<{ parts: Part[] }>(
    token,
    `/collection/${collectionId}`,
  )
  return parts.sort((a, b) =>
    (a.release_date || '9999').localeCompare(b.release_date || '9999'),
  )
}

/** Where the film comes in its franchise by release, from 1. */
async function collectionOrder(
  token: string,
  collectionId: number,
  tmdbId: number,
): Promise<number | null> {
  try {
    const order = (await collectionParts(token, collectionId)).findIndex(
      (part) => part.id === tmdbId,
    )
    return order === -1 ? null : order + 1
  } catch {
    return null
  }
}

/**
 * The show on TVmaze by its IMDb id, else its TheTVDB id (TVmaze lacks IMDb ids
 * for many new shows), or null when TVmaze doesn't have it or can't be reached.
 */
async function tvmazeIdFor(
  imdbId: string | null,
  tvdbId: number | null,
): Promise<number | null> {
  const lookups = [
    imdbId && `imdb=${encodeURIComponent(imdbId)}`,
    tvdbId && `thetvdb=${tvdbId}`,
  ].filter((lookup) => !!lookup)
  for (const lookup of lookups) {
    try {
      const response = await fetch(`${TVMAZE_URL}/lookup/shows?${lookup}`, {
        signal: AbortSignal.timeout(3000),
      })
      if (!response.ok) continue
      const show = (await response.json()) as { id?: unknown }
      if (typeof show.id === 'number') return show.id
    } catch {
      // try the next id
    }
  }
  return null
}

/** When each season airs from season 1, up to the first TMDB has no day for yet. */
function airDates(seasons: { air_date?: string | null }[]): Date[] {
  const days: Date[] = []
  for (const { air_date } of seasons) {
    if (!air_date) break
    days.push(new Date(`${air_date}T00:00:00Z`))
  }
  return days
}

/**
 * Everything stored about a title, read fresh from TMDB, with its franchise
 * order and TVmaze id. `known` skips the TVmaze lookup when the id is already
 * stored.
 */
export async function fetchTitle(
  token: string,
  id: string,
  known: { tvmazeId: number | null } | null = null,
): Promise<Omit<Prisma.CinemaTitleCreateInput, 'Entries'>> {
  const parsed = parseTitleId(id)
  if (!parsed) throw unknownTitle()
  const { kind, tmdbId } = parsed

  const details = await tmdb<Details>(
    token,
    `/${kind === CinemaKind.MOVIE ? 'movie' : 'tv'}/${tmdbId}`,
    { append_to_response: 'videos,external_ids' },
  )
  const imdbId = details.imdb_id ?? details.external_ids?.imdb_id ?? null
  const collection = details.belongs_to_collection ?? null
  // season 0 holds the specials
  const seasons = (details.seasons ?? [])
    .filter((season) => season.season_number > 0)
    .sort((a, b) => a.season_number - b.season_number)

  const [order, tvmazeId] = await Promise.all([
    collection ? collectionOrder(token, collection.id, tmdbId) : null,
    kind === CinemaKind.TV
      ? known?.tvmazeId ??
        tvmazeIdFor(imdbId, details.external_ids?.tvdb_id ?? null)
      : null,
  ])

  return {
    id,
    kind,
    title: details.title ?? details.name ?? '',
    year: yearOf(details.release_date ?? details.first_air_date),
    genres: details.genres.map((genre) => genre.name),
    originalLanguage: details.original_language ?? null,
    posterUrl: image('w500', details.poster_path),
    backdropUrl: image('w1280', details.backdrop_path),
    overview: details.overview?.trim() || null,
    trailerKey: trailerKey(details.videos?.results ?? []),
    collection: collection?.name ?? null,
    collectionOrder: order,
    collectionId: collection?.id ?? null,
    tvmazeId,
    imdbId,
    seasons: kind === CinemaKind.TV ? details.number_of_seasons ?? null : null,
    episodeCounts: seasons.map((season) => season.episode_count),
    seasonAirDates: airDates(seasons),
    status: details.status ?? null,
    released:
      kind === CinemaKind.MOVIE && details.release_date
        ? new Date(`${details.release_date}T00:00:00Z`)
        : null,
  }
}

/**
 * The episode after `season`·`episode`, rolling over into the next season
 * when `episodeCounts` says this one is done, or null after the last episode
 * known. A season TMDB has no count for yet goes on episode by episode.
 */
export function nextEpisode(
  season: number,
  episode: number,
  episodeCounts: number[],
): { season: number; episode: number } | null {
  const inSeason = episodeCounts[season - 1]
  if (inSeason === undefined || episode < inSeason) {
    return { season, episode: episode + 1 }
  }
  if (season < episodeCounts.length) {
    return { season: season + 1, episode: 1 }
  }
  return null
}

/** Whether `a` is past `b`, comparing season first. */
export function isAhead(
  a: { season: number; episode: number },
  b: { season: number; episode: number },
): boolean {
  return a.season > b.season || (a.season === b.season && a.episode > b.episode)
}

/** Runs `work` on each item, `limit` at a time, keeping what came back from those that didn't throw. */
async function settled<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let item = items[next++]; item !== undefined; item = items[next++]) {
        try {
          results.push(await work(item))
        } catch {
          // left out until the next look
        }
      }
    }),
  )
  return results
}

/** The last day a watch can have been on: its day, or the end of its year when the day is forgotten. */
const watchEnd = (watch: { watchedYear: number; watchedDate: Date | null }) =>
  watch.watchedDate ?? new Date(Date.UTC(watch.watchedYear, 11, 31))

/**
 * The last season of a series watched: the highest season of its watches, of
 * those whose seasons aren't told apart every season out by then, or the
 * season its progress finished.
 */
export function lastSeasonWatched(
  entry: {
    season: number | null
    episode: number | null
    Watches: {
      season: number | null
      watchedYear: number
      watchedDate: Date | null
    }[]
  },
  seasonAirDates: Date[],
): number {
  const progress =
    entry.season === null
      ? 0
      : (entry.episode ?? 0) > 0
        ? entry.season
        : entry.season - 1
  return Math.max(
    progress,
    ...entry.Watches.map(
      (watch) =>
        watch.season ??
        seasonAirDates.filter((day) => day <= watchEnd(watch)).length,
    ),
  )
}

// series TMDB won't add seasons to, once their air dates are known
const FINISHED = ['Ended', 'Canceled']

/**
 * Looks on TMDB for the next season of every watched series, out already or
 * only announced, and the next film of every franchise watched so far, for
 * these people or for everyone with shelves, and keeps what it finds as their
 * recommendations. Dropped series and franchises are passed over.
 */
export async function scanRecommendations(
  prisma: PrismaClient,
  token: string,
  profileIds?: string[],
) {
  const entries = await prisma.cinemaEntry.findMany({
    select: {
      id: true,
      viewerId: true,
      titleId: true,
      state: true,
      season: true,
      episode: true,
      droppedAt: true,
      Title: {
        select: {
          kind: true,
          title: true,
          year: true,
          posterUrl: true,
          status: true,
          tvmazeId: true,
          collection: true,
          collectionId: true,
          episodeCounts: true,
          seasonAirDates: true,
          released: true,
        },
      },
      Watches: {
        select: { season: true, watchedYear: true, watchedDate: true },
      },
    },
    where: profileIds ? { viewerId: { in: profileIds } } : {},
  })
  const followed = entries.filter((entry) => !entry.droppedAt)

  // fresh seasons of series still going, the franchise of films from before it
  // was kept, and the day a film still upcoming comes out, which TMDB may move
  const now = new Date()
  const stale = new Map(
    followed
      .filter(({ state, Title }) =>
        Title.kind === CinemaKind.TV
          ? !FINISHED.includes(Title.status ?? '') ||
            Title.seasonAirDates.length === 0
          : (Title.collection !== null && Title.collectionId === null) ||
            (state === CinemaState.UPCOMING &&
              (Title.released === null || Title.released > now)),
      )
      .map((entry) => [entry.titleId, entry.Title]),
  )
  const refreshed = await settled([...stale], 8, async ([id, known]) => {
    const { id: _id, ...data } = await fetchTitle(token, id, known)
    return prisma.cinemaTitle.update({
      select: {
        id: true,
        collectionId: true,
        episodeCounts: true,
        seasonAirDates: true,
      },
      where: { id },
      data,
    })
  })
  for (const fresh of refreshed) {
    for (const entry of entries) {
      if (entry.titleId === fresh.id) {
        entry.Title.collectionId = fresh.collectionId
        entry.Title.episodeCounts = fresh.episodeCounts
        entry.Title.seasonAirDates = fresh.seasonAirDates
      }
    }
  }

  const collectionIds = [
    ...new Set(
      followed
        .map(({ Title }) => Title.collectionId)
        .filter((id): id is number => id !== null),
    ),
  ]
  const franchises = new Map(
    await settled(
      collectionIds,
      8,
      async (id) => [id, await collectionParts(token, id)] as const,
    ),
  )

  const today = now.toISOString().slice(0, 10)
  const people = profileIds ?? [...new Set(entries.map((e) => e.viewerId))]
  const found: Prisma.CinemaRecommendationCreateManyInput[] = []

  for (const profileId of people) {
    const mine = entries.filter((entry) => entry.viewerId === profileId)
    const dropped = new Set(
      mine
        .filter((entry) => entry.droppedAt && entry.Title.collection)
        .map((entry) => entry.Title.collection),
    )
    const shelved = new Set(mine.map((entry) => entry.titleId))

    for (const entry of mine) {
      const { Title } = entry
      if (
        Title.kind !== CinemaKind.TV ||
        entry.state !== CinemaState.WATCHED ||
        entry.droppedAt
      ) {
        continue
      }
      // out already or still to come: TMDB lists a season once it is
      // announced, before it has a day
      const listed = Math.max(
        Title.episodeCounts.length,
        Title.seasonAirDates.length,
      )
      const last = lastSeasonWatched(entry, Title.seasonAirDates)
      if (listed > last) {
        found.push({
          profileId,
          kind: CinemaRecommendationKind.NEXT_SEASON,
          entryId: entry.id,
          titleId: entry.titleId,
          title: Title.title,
          year: Title.year,
          posterUrl: Title.posterUrl,
          season: last + 1,
        })
      }
    }

    // the film after the latest of each franchise, once that one is watched and the next is out
    for (const [collectionId, parts] of franchises) {
      const films = mine.filter(
        ({ Title }) =>
          Title.collectionId === collectionId && !dropped.has(Title.collection),
      )
      const at = (entry: (typeof films)[number]) =>
        parts.findIndex((part) => `movie:${part.id}` === entry.titleId)
      const latest = films.sort((a, b) => at(b) - at(a))[0]
      const next = latest && parts[at(latest) + 1]
      if (
        !latest ||
        !next ||
        latest.state !== CinemaState.WATCHED ||
        !next.release_date ||
        next.release_date > today ||
        shelved.has(`movie:${next.id}`)
      ) {
        continue
      }
      found.push({
        profileId,
        kind: CinemaRecommendationKind.NEXT_IN_FRANCHISE,
        entryId: latest.id,
        titleId: `movie:${next.id}`,
        title: next.title,
        year: yearOf(next.release_date),
        posterUrl: image('w500', next.poster_path),
        released: new Date(next.release_date),
      })
    }
  }

  await prisma.$transaction([
    prisma.cinemaRecommendation.deleteMany({
      where: { profileId: { in: people } },
    }),
    prisma.cinemaRecommendation.createMany({ data: found }),
    ...people.map((profileId) =>
      prisma.cinemaPreference.upsert({
        where: { profileId },
        create: { profileId, checkedAt: now },
        update: { checkedAt: now },
      }),
    ),
  ])
}
