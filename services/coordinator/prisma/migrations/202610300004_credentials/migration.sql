ALTER TABLE "Credential" ADD COLUMN "holderInstanceId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Credential" ADD COLUMN "tokenHash" TEXT;
ALTER TABLE "Credential" ADD COLUMN "revoked" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "Credential_tokenHash_key" ON "Credential"("tokenHash");
