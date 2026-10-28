-- CreateTable
CREATE TABLE "LibraryBook" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "authors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "year" INTEGER,
    "pages" INTEGER,
    "coverUrl" TEXT,
    "isbn" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LibraryBook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryReading" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "readYear" INTEGER NOT NULL,
    "readDate" DATE,
    "readById" TEXT NOT NULL,
    "addedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LibraryReading_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LibraryReading_readById_idx" ON "LibraryReading"("readById");

-- AddForeignKey
ALTER TABLE "LibraryReading" ADD CONSTRAINT "LibraryReading_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "LibraryBook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryReading" ADD CONSTRAINT "LibraryReading_readById_fkey" FOREIGN KEY ("readById") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryReading" ADD CONSTRAINT "LibraryReading_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

