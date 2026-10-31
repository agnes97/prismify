import { CinemaKind, Prisma, type PrismaClient } from '@prisma/client'

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
} satisfies Prisma.CinemaTitleSelect

export const entrySelect = {
  id: true,
  state: true,
  season: true,
  episode: true,
  watchedYear: true,
  watchedDate: true,
  togetherId: true,
  mainGenre: true,
  createdAt: true,
  updatedAt: true,
  Title: { select: titleSelect },
  Viewer: { select: profileSelect },
  AddedBy: { select: profileSelect },
} satisfies Prisma.CinemaEntrySelect

type EntryRecord = Prisma.CinemaEntryGetPayload<{
  select: typeof entrySelect
}>

export function toEntry({
  watchedYear,
  watchedDate,
  Title,
  Viewer,
  AddedBy,
  ...entry
}: EntryRecord) {
  return {
    ...entry,
    watched: watchedDate
      ? watchedDate.toISOString().slice(0, 10)
      : watchedYear === null
        ? null
        : String(watchedYear),
    title: Title,
    viewer: Viewer,
    addedBy: AddedBy,
  }
}

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
  seasons?: { season_number: number; episode_count: number }[]
  number_of_seasons?: number
  videos?: { results: Video[] }
  external_ids?: { imdb_id?: string | null }
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

/** Where the film comes in its franchise by release, from 1. */
async function collectionOrder(
  token: string,
  collectionId: number,
  tmdbId: number,
): Promise<number | null> {
  try {
    const { parts } = await tmdb<{
      parts: { id: number; release_date?: string }[]
    }>(token, `/collection/${collectionId}`)
    // unreleased ones without a date go last
    const order = parts
      .sort((a, b) =>
        (a.release_date || '9999').localeCompare(b.release_date || '9999'),
      )
      .findIndex((part) => part.id === tmdbId)
    return order === -1 ? null : order + 1
  } catch {
    return null
  }
}

/** The show on TVmaze by its IMDb id, or null when TVmaze doesn't have it or can't be reached. */
async function tvmazeIdFor(imdbId: string): Promise<number | null> {
  try {
    const response = await fetch(
      `${TVMAZE_URL}/lookup/shows?imdb=${encodeURIComponent(imdbId)}`,
      { signal: AbortSignal.timeout(3000) },
    )
    if (!response.ok) return null
    const show = (await response.json()) as { id?: unknown }
    return typeof show.id === 'number' ? show.id : null
  } catch {
    return null
  }
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
      ? known?.tvmazeId ?? (imdbId ? tvmazeIdFor(imdbId) : null)
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
    tvmazeId,
    imdbId,
    seasons: kind === CinemaKind.TV ? details.number_of_seasons ?? null : null,
    episodeCounts: seasons.map((season) => season.episode_count),
    status: details.status ?? null,
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
