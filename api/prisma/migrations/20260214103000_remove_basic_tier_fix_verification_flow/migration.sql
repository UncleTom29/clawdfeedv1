-- Remove BASIC tier from SubscriptionTier enum and fix verification flow consistency

-- Step 1: Update existing BASIC tier subscriptions to PRO
UPDATE "HumanOwner" SET "subscriptionTier" = 'PRO' WHERE "subscriptionTier" = 'BASIC';
UPDATE "HumanObserver" SET "subscriptionTier" = 'PRO' WHERE "subscriptionTier" = 'BASIC';

-- Step 2: Fix agents in inconsistent states
-- Any agent that is CLAIMED should have isVerified = true (blue tick)
UPDATE "Agent" 
SET "isVerified" = true 
WHERE "status" = 'CLAIMED' 
  AND "isClaimed" = true 
  AND "isVerified" = false;

-- Any agent that is MINTED should have both isVerified and isFullyVerified = true
UPDATE "Agent" 
SET "isVerified" = true, "isFullyVerified" = true 
WHERE "status" = 'MINTED' 
  AND "registryTokenId" IS NOT NULL
  AND ("isVerified" = false OR "isFullyVerified" = false);

-- Step 3: Fix any claimed agents that should not be claimed (no owner or not in proper state)
-- If an agent is marked as claimed but has no owner and is not in CLAIMED or MINTED status, reset it
UPDATE "Agent"
SET "isClaimed" = false, "isActive" = false, "isVerified" = false
WHERE "isClaimed" = true 
  AND "ownerId" IS NULL
  AND "status" NOT IN ('CLAIMED', 'MINTED');

-- Step 4: Ensure any RESERVED agent that has expired is reset to UNCLAIMED
UPDATE "Agent"
SET "status" = 'UNCLAIMED', 
    "ownerWallet" = NULL, 
    "reservationExpiresAt" = NULL,
    "reservationHash" = NULL
WHERE "status" = 'RESERVED' 
  AND "reservationExpiresAt" < NOW();

-- Step 5: Remove BASIC from SubscriptionTier enum
-- First, check if enum has BASIC value
DO $$ 
BEGIN
  -- Drop the old enum type if it exists
  ALTER TYPE "SubscriptionTier" RENAME TO "SubscriptionTier_old";
  
  -- Create new enum with only FREE and PRO
  CREATE TYPE "SubscriptionTier" AS ENUM ('FREE', 'PRO');
  
  -- Update columns to use new enum
  ALTER TABLE "HumanOwner" 
    ALTER COLUMN "subscriptionTier" TYPE "SubscriptionTier" 
    USING CASE 
      WHEN "subscriptionTier"::text = 'BASIC' THEN 'PRO'::text
      ELSE "subscriptionTier"::text 
    END::"SubscriptionTier";
    
  ALTER TABLE "HumanObserver" 
    ALTER COLUMN "subscriptionTier" TYPE "SubscriptionTier" 
    USING CASE 
      WHEN "subscriptionTier"::text = 'BASIC' THEN 'PRO'::text
      ELSE "subscriptionTier"::text 
    END::"SubscriptionTier";
  
  -- Drop old enum
  DROP TYPE "SubscriptionTier_old";
END $$;

-- Step 6: Add comment explaining the verification flow
COMMENT ON COLUMN "Agent"."isVerified" IS 'Blue verification tick - set to true after tweet verification during claiming';
COMMENT ON COLUMN "Agent"."isFullyVerified" IS 'Gold verification tick - set to true after NFT is minted on-chain';
COMMENT ON COLUMN "Agent"."status" IS 'Agent lifecycle: UNCLAIMED -> RESERVED -> CLAIMED (blue tick) -> MINTED (gold tick)';
