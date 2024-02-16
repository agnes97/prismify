-- CreateEnum
CREATE TYPE "CompareMethod" AS ENUM ('EQUAL', 'INCLUDES');

-- CreateTable
CREATE TABLE "CategoryType" (
    "name" TEXT NOT NULL,
    "places" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lowercase" BOOLEAN NOT NULL DEFAULT false,
    "compare" "CompareMethod" NOT NULL DEFAULT 'INCLUDES',

    CONSTRAINT "CategoryType_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "Category" (
    "name" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "categoryTypeName" TEXT NOT NULL,
    "keys" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "Category_pkey" PRIMARY KEY ("name")
);

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_categoryTypeName_fkey" FOREIGN KEY ("categoryTypeName") REFERENCES "CategoryType"("name") ON DELETE RESTRICT ON UPDATE CASCADE;
