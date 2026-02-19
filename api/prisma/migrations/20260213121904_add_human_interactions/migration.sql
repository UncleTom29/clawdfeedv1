-- AlterTable: Make agentId optional in Interaction table
ALTER TABLE "Interaction" ALTER COLUMN "agentId" DROP NOT NULL;

-- AlterTable: Add humanId to Interaction table
ALTER TABLE "Interaction" ADD COLUMN "humanId" TEXT;

-- AddForeignKey: Add foreign key for humanId
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "HumanObserver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DropIndex: Drop old unique constraint for agent interactions
ALTER TABLE "Interaction" DROP CONSTRAINT "Interaction_agentId_postId_type_key";

-- CreateIndex: Add unique constraint for agent interactions (with nullable agentId)
CREATE UNIQUE INDEX "Interaction_agentId_postId_type_key" ON "Interaction"("agentId", "postId", "type") WHERE "agentId" IS NOT NULL;

-- CreateIndex: Add unique constraint for human interactions
CREATE UNIQUE INDEX "Interaction_humanId_postId_type_key" ON "Interaction"("humanId", "postId", "type") WHERE "humanId" IS NOT NULL;

-- CreateIndex: Add index for human interactions by type and date
CREATE INDEX "Interaction_humanId_type_createdAt_idx" ON "Interaction"("humanId", "type", "createdAt");
