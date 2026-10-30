# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
docker compose up -d                          # Local Postgres (:5432) + Adminer (:8080), reads .env
pnpm dev                                      # tsc + watch, serves dist/src/app.js on localhost:3000
pnpm lint / pnpm lint:fix                     # ESLint (typescript-eslint strict-type-checked)
pnpm format / pnpm format:check               # Prettier
pnpm prisma migrate dev --name <name>         # Create + apply a migration after editing schema.prisma
pnpm prisma generate                          # Regenerate the client (also runs on postinstall)
```

`.env` is copied from `.env.template`. There are no tests. If files are moved or renamed while `pnpm dev` is running, stale output in `dist/` can break things — stop dev and `rm -rf ./dist`.

## Architecture

**Fastify 4 + Prisma 5 (PostgreSQL) + Zod**, ESM, deployed to **Vercel** as a single serverless function: `vercel.json` rewrites every path to `api/serverless.ts`, which registers `src/app.ts` as a plugin. It is the shared backend for personal projects (portfolio CV, rating app, shopping mall scraper, library), served at `https://prismify.macovi.space`.

`src/app.ts` uses `@fastify/autoload` twice — do not edit it to register routes or plugins:

- `src/plugins/*.ts` — non-encapsulated (`fastify-plugin`) decorators shared by all routes:
  - `prisma` → `fastify.prisma` (PrismaClient)
  - `config` → `fastify.config` (env validated with Zod; add new env vars to its `configSchema` and `.env.template`)
  - `authenticate` → `fastify.authenticate` (JWT `onRequest` hook; sets `request.user.id`)
  - `zod` → Zod validator/serializer compilers, `cors`, `sensible`
- `src/routes/**` — **the folder path is the URL prefix**. `routes/rating/index.ts` serves `/rating/...`, `routes/shopping-mall/items/index.ts` serves `/shopping-mall/items/...`, `routes/root.ts` serves `/`.

`src/routes/example/` is leftover scaffolding.

## Adding or changing endpoints

Follow the pattern in `src/routes/rating/index.ts` (the most complete example) and `src/routes/auth/index.ts`.

### 1. Where the code goes

- **New resource** → new folder `src/routes/<resource>/index.ts` exporting a default `FastifyPluginAsync`. Autoload picks it up; nothing else to register.
- **New endpoint on an existing resource** → add another `fastify.<method>(...)` call inside that resource's existing plugin (e.g. `PUT /rating/:id/votes` lives in `routes/rating/index.ts`). Don't create a sibling file for it.
- Non-trivial pure logic goes in a `<resource>.helper.ts` next to `index.ts`; large Zod input schemas go in `<resource>.validation.ts` (see `shopping-mall/items/`).
- Relative imports use the **`.js` extension** (`import { maskData } from './cv.helper.js'`) — required for ESM output.

### 2. Skeleton

```ts
import { FastifyPluginAsync } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

const things: FastifyPluginAsync = async (fastify, _opts): Promise<void> => {
  // Protect every route in this plugin (omit for public resources)
  fastify.addHook('onRequest', fastify.authenticate)

  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/:id',
    {
      schema: {
        params: z.object({ id: z.string() }),
      },
    },
    async function (request, reply) {
      const thing = await fastify.prisma.thing.findUnique({
        select: { id: true, title: true },
        where: { id: request.params.id },
      })

      if (!thing) {
        return reply.status(404).send({ message: 'Thing not found' })
      }

      return thing
    },
  )
}

export default things
```

### 3. Conventions

- **Validation**: any route with `params`, `querystring` or `body` uses `.withTypeProvider<ZodTypeProvider>()` and a Zod `schema`, so `request.*` is typed. Don't hand-type generics like `get<{ Querystring: ... }>` (only the legacy `access` route does that).
- **Auth**:
  - whole resource protected → `fastify.addHook('onRequest', fastify.authenticate)` at the top of the plugin (rating, shopping-mall/items);
  - single protected route in a public resource → `{ onRequest: [fastify.authenticate] }` in route options (`GET /auth/me`).
  - The current user is `request.user.id` (a `User.id` / `Profile.id` UUID). Check authorization explicitly (e.g. 403 when the user isn't a rating participant).
- **Errors**: `return reply.status(<code>).send({ message: '<human sentence>' })` — 400 bad input / business rule, 401 bad credentials, 403 not allowed, 404 not found. Clients (library, portfolio) read `message`.
- **Prisma queries**: always use explicit `select` to return only what the client needs — never leak `User.password`. Reshape relation fields to camelCase before returning (`Participants` → `participants`, flatten `profile` into the user). Multi-write operations go in `fastify.prisma.$transaction(...)`; map `PrismaClientKnownRequestError` codes (e.g. `P2025`) to 400s and rethrow anything else.
- **Large bodies**: use `fastify.route({ method, url, bodyLimit, schema, handler })` like the shopping-mall `PUT`.
- Code style: Prettier (no semicolons, single quotes, trailing commas). Unused params are prefixed `_` (`_opts`, `_request`, `_reply`).

### 4. Database changes

When an endpoint needs new tables or columns (as in the CV, access log and rating commits):

1. Edit `prisma/schema.prisma` (models are grouped under `// <Project>` comments).
2. `pnpm prisma migrate dev --name <snake_case_name>` — commit the generated `prisma/migrations/<timestamp>_<name>/migration.sql` together with the schema change and the route code.
3. Seed / admin data is not created through endpoints — write the SQL in `prisma/queries/<verb>_<thing>.sql` (run manually against Vercel Postgres). Never commit real passwords or personal data there.

### 5. Commits

One gitmoji-prefixed commit per endpoint/feature, imperative and short:
`✨ Add endpoint to …` (feature), `🐛 Fix …`, `🗃️ …` (schema/migrations only), `🔧 …` (config), `🦺 …` (validation), `🧐 …` (db queries).

Keep `master` a straight line, with no merge commits: rebase a feature branch onto `master` (`git rebase master`) and then fast-forward it in (`git merge --ff-only <branch>`); never `git merge --no-ff` or a merge commit from a pull. The repo is set to `merge.ff only` and `pull.rebase true` locally, so a merge that can't fast-forward fails instead of creating one.

After changing an endpoint's request or response shape, update the clients that use it (e.g. `../library/src/lib/auth.svelte.ts`, `../agnes97-portfolio`).
