-- CreateTable
CREATE TABLE "Rating" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "hasFavorites" BOOLEAN NOT NULL DEFAULT true,
    "maxRating" INTEGER NOT NULL DEFAULT 5,
    "minRating" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Rating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RatingItem" (
    "id" TEXT NOT NULL,
    "ratingId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "favoriteById" TEXT,

    CONSTRAINT "RatingItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RatingVote" (
    "id" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "ratingItemId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,

    CONSTRAINT "RatingVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ProfileToRating" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "RatingVote_ratingItemId_participantId_key" ON "RatingVote"("ratingItemId", "participantId");

-- CreateIndex
CREATE UNIQUE INDEX "_ProfileToRating_AB_unique" ON "_ProfileToRating"("A", "B");

-- CreateIndex
CREATE INDEX "_ProfileToRating_B_index" ON "_ProfileToRating"("B");

-- AddForeignKey
ALTER TABLE "RatingItem" ADD CONSTRAINT "RatingItem_ratingId_fkey" FOREIGN KEY ("ratingId") REFERENCES "Rating"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatingItem" ADD CONSTRAINT "RatingItem_favoriteById_fkey" FOREIGN KEY ("favoriteById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatingVote" ADD CONSTRAINT "RatingVote_ratingItemId_fkey" FOREIGN KEY ("ratingItemId") REFERENCES "RatingItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatingVote" ADD CONSTRAINT "RatingVote_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProfileToRating" ADD CONSTRAINT "_ProfileToRating_A_fkey" FOREIGN KEY ("A") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProfileToRating" ADD CONSTRAINT "_ProfileToRating_B_fkey" FOREIGN KEY ("B") REFERENCES "Rating"("id") ON DELETE CASCADE ON UPDATE CASCADE;
