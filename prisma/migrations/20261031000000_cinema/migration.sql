-- CreateEnum
CREATE TYPE "CinemaKind" AS ENUM ('MOVIE', 'TV');

-- CreateEnum
CREATE TYPE "CinemaState" AS ENUM ('UPCOMING', 'WATCHING', 'WATCHED');

-- CreateTable
CREATE TABLE "CinemaTitle" (
    "id" TEXT NOT NULL,
    "kind" "CinemaKind" NOT NULL,
    "title" TEXT NOT NULL,
    "year" INTEGER,
    "genres" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "originalLanguage" TEXT,
    "posterUrl" TEXT,
    "backdropUrl" TEXT,
    "overview" TEXT,
    "trailerKey" TEXT,
    "collection" TEXT,
    "collectionOrder" INTEGER,
    "tvmazeId" INTEGER,
    "imdbId" TEXT,
    "seasons" INTEGER,
    "episodeCounts" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "status" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CinemaTitle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CinemaEntry" (
    "id" TEXT NOT NULL,
    "titleId" TEXT NOT NULL,
    "viewerId" TEXT NOT NULL,
    "addedById" TEXT NOT NULL,
    "state" "CinemaState" NOT NULL,
    "season" INTEGER,
    "episode" INTEGER,
    "watchedYear" INTEGER,
    "watchedDate" DATE,
    "togetherId" TEXT,
    "mainGenre" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CinemaEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CinemaLink" (
    "id" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CinemaLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CinemaPreference" (
    "profileId" TEXT NOT NULL,
    "view" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CinemaPreference_pkey" PRIMARY KEY ("profileId")
);

-- CreateIndex
CREATE INDEX "CinemaEntry_togetherId_idx" ON "CinemaEntry"("togetherId");

-- CreateIndex
CREATE UNIQUE INDEX "CinemaEntry_viewerId_titleId_key" ON "CinemaEntry"("viewerId", "titleId");

-- CreateIndex
CREATE INDEX "CinemaLink_toId_idx" ON "CinemaLink"("toId");

-- CreateIndex
CREATE UNIQUE INDEX "CinemaLink_fromId_toId_key" ON "CinemaLink"("fromId", "toId");

-- AddForeignKey
ALTER TABLE "CinemaEntry" ADD CONSTRAINT "CinemaEntry_titleId_fkey" FOREIGN KEY ("titleId") REFERENCES "CinemaTitle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CinemaEntry" ADD CONSTRAINT "CinemaEntry_viewerId_fkey" FOREIGN KEY ("viewerId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CinemaEntry" ADD CONSTRAINT "CinemaEntry_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CinemaLink" ADD CONSTRAINT "CinemaLink_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CinemaLink" ADD CONSTRAINT "CinemaLink_toId_fkey" FOREIGN KEY ("toId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CinemaPreference" ADD CONSTRAINT "CinemaPreference_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

