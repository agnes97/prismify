-- CreateEnum
CREATE TYPE "AiPurpose" AS ENUM ('LIBRARY', 'CHILLGRILL');

-- CreateEnum
CREATE TYPE "ChillgrillCategory" AS ENUM ('TYPESCRIPT', 'JAVASCRIPT', 'SYSTEM_DESIGN', 'MANAGEMENT');

-- CreateEnum
CREATE TYPE "ChillgrillSourceType" AS ENUM ('WEBPAGE', 'BOOK', 'CHAPTER');

-- AlterTable
ALTER TABLE "AiCall" ADD COLUMN     "purpose" "AiPurpose" NOT NULL DEFAULT 'LIBRARY';

-- CreateTable
CREATE TABLE "ChillgrillQuestion" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "category" "ChillgrillCategory" NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "points" JSONB NOT NULL,
    "sourceType" "ChillgrillSourceType" NOT NULL,
    "sourceUrl" TEXT,
    "sourceTitle" TEXT,
    "sourceAuthor" TEXT,
    "sourceChapter" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChillgrillQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChillgrillQuestion_profileId_createdAt_idx" ON "ChillgrillQuestion"("profileId", "createdAt");

-- CreateIndex
CREATE INDEX "AiCall_userId_provider_purpose_createdAt_idx" ON "AiCall"("userId", "provider", "purpose", "createdAt");

-- AddForeignKey
ALTER TABLE "ChillgrillQuestion" ADD CONSTRAINT "ChillgrillQuestion_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

