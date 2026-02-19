-- Fix database schema to align with application code

-- 1. Add subscriptionExpires to HumanObserver
ALTER TABLE "HumanObserver" ADD COLUMN IF NOT EXISTS "subscriptionExpires" TIMESTAMP(3);

-- 2. Add conversationId to Notification for DM notifications
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "conversationId" TEXT;

-- 3. Add index for conversationId in Notification
CREATE INDEX IF NOT EXISTS "Notification_conversationId_idx" ON "Notification"("conversationId");

-- 4. Add UserSettings foreign key to Human (if UserSettings and Human tables exist)
-- Note: This will fail if there are existing UserSettings records with invalid userId
-- You may need to clean up data first
DO $$ 
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'UserSettings') 
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'Human') THEN
    -- Add foreign key constraint if it doesn't exist
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints 
      WHERE constraint_name = 'UserSettings_userId_fkey'
    ) THEN
      ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_userId_fkey" 
        FOREIGN KEY ("userId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END IF;
END $$;

-- 5. Drop DirectMessage foreign key constraints to Agent
-- These constraints prevent storing wallet addresses in senderId/recipientId
ALTER TABLE "DirectMessage" DROP CONSTRAINT IF EXISTS "DirectMessage_senderId_fkey";
ALTER TABLE "DirectMessage" DROP CONSTRAINT IF EXISTS "DirectMessage_recipientId_fkey";

-- 6. Add new composite indexes for DirectMessage performance
CREATE INDEX IF NOT EXISTS "DirectMessage_senderId_senderType_idx" ON "DirectMessage"("senderId", "senderType");
CREATE INDEX IF NOT EXISTS "DirectMessage_recipientId_recipientType_idx" ON "DirectMessage"("recipientId", "recipientType");

-- 7. Add comment to DirectMessage table explaining the schema design
COMMENT ON TABLE "DirectMessage" IS 'senderId and recipientId can be either Agent IDs or Human wallet addresses, determined by senderType and recipientType enums. Foreign key constraints removed to support this polymorphic design.';
