CREATE TABLE "EvaluationDispatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "holderInstanceId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "expiresAt" REAL NOT NULL,
    "workJson" TEXT NOT NULL,
    "resultJson" TEXT
);
CREATE INDEX "EvaluationDispatch_groupId_holderInstanceId_state_idx" ON "EvaluationDispatch"("groupId", "holderInstanceId", "state");
