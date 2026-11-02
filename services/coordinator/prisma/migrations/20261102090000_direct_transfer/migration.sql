CREATE TABLE "DataEndpoint" ("id" TEXT NOT NULL PRIMARY KEY, "groupId" TEXT NOT NULL, "holderInstanceId" TEXT NOT NULL, "credentialId" TEXT NOT NULL, "coordinatorEpoch" INTEGER NOT NULL, "metadataJson" TEXT NOT NULL);
CREATE UNIQUE INDEX "DataEndpoint_groupId_holderInstanceId_key" ON "DataEndpoint"("groupId", "holderInstanceId");
CREATE TABLE "TransferAuthorization" ("id" TEXT NOT NULL PRIMARY KEY, "groupId" TEXT NOT NULL, "attemptId" TEXT NOT NULL, "endpointId" TEXT NOT NULL, "requesterCredentialId" TEXT NOT NULL, "state" TEXT NOT NULL, "expiresAt" REAL NOT NULL, "metadataJson" TEXT NOT NULL);
CREATE INDEX "TransferAuthorization_groupId_attemptId_idx" ON "TransferAuthorization"("groupId", "attemptId");
CREATE INDEX "TransferAuthorization_expiresAt_idx" ON "TransferAuthorization"("expiresAt");
CREATE TABLE "DataReplica" ("id" TEXT NOT NULL PRIMARY KEY, "groupId" TEXT NOT NULL, "endpointId" TEXT NOT NULL, "metadataJson" TEXT NOT NULL);
CREATE INDEX "DataReplica_groupId_endpointId_idx" ON "DataReplica"("groupId", "endpointId");
CREATE TABLE "PeerNetwork" ("id" TEXT NOT NULL PRIMARY KEY, "groupId" TEXT NOT NULL, "holderInstanceId" TEXT NOT NULL, "credentialId" TEXT NOT NULL, "metadataJson" TEXT NOT NULL);
CREATE UNIQUE INDEX "PeerNetwork_groupId_holderInstanceId_key" ON "PeerNetwork"("groupId", "holderInstanceId");
