# Getting Started with Fastify-CLI

This project was bootstrapped with [Fastify-CLI](https://www.npmjs.com/package/fastify-cli).

To learn Fastify, check out the [Fastify documentation](https://fastify.dev/docs/latest/).

## Prerequisities

- [Git](https://git-scm.com/)
- [Node.js](https://nodejs.org/)
- [pnpm](https://pnpm.io/)
- [Docker](https://www.docker.com/)

## Setup project locally

Install dependencies:

```
pnpm install
```

Copy the `.env.template` file as the `.env` file and update default values if needed.

Run the Docker Compose to setup the local environment:

```
docker compose up -d
```

## Run project locally

To start the app in dev mode run:

```
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) to view it in the browser.

## Database migrations

Project uses Prisma to handle database migrations. To learn more check out the [Prisma Migrate documentation](https://www.prisma.io/docs/orm/prisma-migrate/getting-started).

To create a new migration run:

```
pnpm prisma migrate dev --name <migration_name>
```

To apply all existing migrations run:

```
pnpm prisma migrate dev
```

## Troubleshooting

If you are creating or moving files while the watch mode is running it can create a compilation "ghosts" causing problems in the `dist/` folder.

To remove them simply stop the dev mode and run:

```
rm -rf ./dist
```
