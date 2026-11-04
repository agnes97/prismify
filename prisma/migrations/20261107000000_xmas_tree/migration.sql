-- CreateTable
CREATE TABLE "XmasTree" (
    "profileId" TEXT NOT NULL,
    "baubles" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XmasTree_pkey" PRIMARY KEY ("profileId")
);

-- AddForeignKey
ALTER TABLE "XmasTree" ADD CONSTRAINT "XmasTree_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

