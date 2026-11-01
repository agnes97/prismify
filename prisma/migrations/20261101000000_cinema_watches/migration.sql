-- CreateTable
CREATE TABLE "CinemaWatch" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "season" INTEGER,
    "watchedYear" INTEGER NOT NULL,
    "watchedDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CinemaWatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CinemaWatch_entryId_idx" ON "CinemaWatch"("entryId");

-- AddForeignKey
ALTER TABLE "CinemaWatch" ADD CONSTRAINT "CinemaWatch_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "CinemaEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Each entry's watch date becomes its first watch, its seasons not told apart
INSERT INTO "CinemaWatch" ("id", "entryId", "season", "watchedYear", "watchedDate")
SELECT gen_random_uuid()::text, "id", NULL, "watchedYear", "watchedDate"
FROM "CinemaEntry"
WHERE "watchedYear" IS NOT NULL;

-- AlterTable
ALTER TABLE "CinemaEntry" DROP COLUMN "watchedDate",
DROP COLUMN "watchedYear";
