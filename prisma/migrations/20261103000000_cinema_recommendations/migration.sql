-- CreateEnum
CREATE TYPE "CinemaRecommendationKind" AS ENUM ('NEXT_SEASON', 'NEXT_IN_FRANCHISE');

-- AlterTable
ALTER TABLE "CinemaEntry" ADD COLUMN     "droppedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "CinemaPreference" ADD COLUMN     "checkedAt" TIMESTAMP(3),
ALTER COLUMN "view" SET DEFAULT 'everyone';

-- AlterTable
ALTER TABLE "CinemaTitle" ADD COLUMN     "collectionId" INTEGER,
ADD COLUMN     "seasonAirDates" DATE[] DEFAULT ARRAY[]::DATE[];

-- CreateTable
CREATE TABLE "CinemaRecommendation" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "kind" "CinemaRecommendationKind" NOT NULL,
    "entryId" TEXT NOT NULL,
    "titleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "year" INTEGER,
    "posterUrl" TEXT,
    "season" INTEGER,
    "foundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CinemaRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CinemaRecommendation_profileId_kind_titleId_key" ON "CinemaRecommendation"("profileId", "kind", "titleId");

-- AddForeignKey
ALTER TABLE "CinemaRecommendation" ADD CONSTRAINT "CinemaRecommendation_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CinemaRecommendation" ADD CONSTRAINT "CinemaRecommendation_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "CinemaEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
