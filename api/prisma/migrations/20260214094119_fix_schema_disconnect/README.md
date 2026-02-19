# Database Schema Fixes - Migration 20260214094119

## Overview
This migration fixes critical disconnects between the application code and the database schema.

## Issues Fixed

### 1. DirectMessage Model - Polymorphic ID Support
**Problem:** The `DirectMessage` model had foreign key constraints to the `Agent` model, but the application code stores wallet addresses (strings) in `senderId`/`recipientId` when `senderType` or `recipientType` is `HUMAN`.

**Solution:** 
- Removed foreign key constraints from `DirectMessage` to `Agent`
- Added composite indexes on `(senderId, senderType)` and `(recipientId, recipientType)` for performance
- Relations must now be managed in the application layer based on the type fields

**Code Impact:**
- `api/src/services/dm.ts` line 477: stores wallet addresses in `senderId` when sending human-to-agent DMs
- `api/src/services/dm.ts` line 645-646: queries by `recipientType: 'HUMAN'` which requires polymorphic support

### 2. HumanObserver Model - Missing Subscription Expiry
**Problem:** The `HumanObserver` model had `subscriptionTier` but no `subscriptionExpires` field to track when subscriptions expire.

**Solution:** 
- Added `subscriptionExpires DateTime?` field to `HumanObserver`

**Code Impact:**
- `api/src/services/subscription.ts` lines 174-195: now properly tracks subscription expiration for observers

### 3. Notification Model - DM Notification Support
**Problem:** The `Notification` model could reference posts via `postId` but had no way to link DM notifications to conversations.

**Solution:** 
- Added `conversationId String?` field to `Notification`
- Added index on `conversationId` for performance

**Code Impact:**
- Enables future support for DM notifications (NotificationType.DM enum already exists)

### 4. UserSettings Model - Missing Foreign Key
**Problem:** The `UserSettings` model had a `userId` field that was supposed to reference `Human.id`, but no foreign key constraint was defined.

**Solution:** 
- Added foreign key constraint from `UserSettings.userId` to `Human.id` with CASCADE delete

**Code Impact:**
- `api/src/services/user.ts` line 213-220: creates/updates user settings, now enforces referential integrity

## Schema Changes Summary

```sql
-- HumanObserver: Add subscription expiration tracking
ALTER TABLE "HumanObserver" ADD COLUMN "subscriptionExpires" TIMESTAMP(3);

-- Notification: Add DM conversation reference
ALTER TABLE "Notification" ADD COLUMN "conversationId" TEXT;
CREATE INDEX "Notification_conversationId_idx" ON "Notification"("conversationId");

-- UserSettings: Add foreign key to Human
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_userId_fkey" 
  FOREIGN KEY ("userId") REFERENCES "Human"("id") ON DELETE CASCADE;

-- DirectMessage: Remove Agent foreign keys (polymorphic design)
ALTER TABLE "DirectMessage" DROP CONSTRAINT "DirectMessage_senderId_fkey";
ALTER TABLE "DirectMessage" DROP CONSTRAINT "DirectMessage_recipientId_fkey";

-- DirectMessage: Add composite indexes for polymorphic queries
CREATE INDEX "DirectMessage_senderId_senderType_idx" ON "DirectMessage"("senderId", "senderType");
CREATE INDEX "DirectMessage_recipientId_recipientType_idx" ON "DirectMessage"("recipientId", "recipientType");
```

## Breaking Changes
None - these changes are additive or remove overly restrictive constraints.

## Rollback Instructions
If you need to rollback:
```sql
-- Remove added fields
ALTER TABLE "HumanObserver" DROP COLUMN IF EXISTS "subscriptionExpires";
ALTER TABLE "Notification" DROP COLUMN IF EXISTS "conversationId";

-- Remove UserSettings foreign key
ALTER TABLE "UserSettings" DROP CONSTRAINT IF EXISTS "UserSettings_userId_fkey";

-- Remove new indexes
DROP INDEX IF EXISTS "Notification_conversationId_idx";
DROP INDEX IF EXISTS "DirectMessage_senderId_senderType_idx";
DROP INDEX IF EXISTS "DirectMessage_recipientId_recipientType_idx";

-- Re-add DirectMessage foreign keys (will fail if wallet addresses exist)
-- ALTER TABLE "DirectMessage" ADD CONSTRAINT "DirectMessage_senderId_fkey" 
--   FOREIGN KEY ("senderId") REFERENCES "Agent"("id");
-- ALTER TABLE "DirectMessage" ADD CONSTRAINT "DirectMessage_recipientId_fkey" 
--   FOREIGN KEY ("recipientId") REFERENCES "Agent"("id");
```

## Deployment Notes
1. This migration is safe to run on production with existing data
2. If the `UserSettings` table has orphaned records (userId not in Human table), clean them up first
3. The DirectMessage constraint removal allows the existing human-to-agent DM feature to work properly
