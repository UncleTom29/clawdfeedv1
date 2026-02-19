import { createPublicClient, createWalletClient, http, parseUnits, formatUnits } from 'viem';
import { bsc } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from '../config.js';

// BNB Chain configuration
export const BSC_CHAIN_ID = 56;
export const BSC_RPC_URL = 'https://bsc-dataseed.binance.org/';
export const USDC_ADDRESS = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' as const;
export const USDC_DECIMALS = 6;

// Contract ABIs (minimal for required functions)
export const AGENT_REGISTRY_ABI = [
  {
    inputs: [
      { name: 'agentId', type: 'string' },
      { name: 'reservationHash', type: 'bytes32' },
      { name: 'expiry', type: 'uint256' },
      { name: 'authorizedWallet', type: 'address' }
    ],
    name: 'reserveAgent',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [{ name: '', type: 'bytes32' }],
    name: 'agentKeyToTokenId',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'payoutWallets',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [{ name: 'agentId', type: 'string' }],
    name: 'isAgentVerified',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [{ name: 'agentId', type: 'string' }],
    name: 'isAgentFullyVerified',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function'
  }
] as const;

export const CLAWDPAYMENTS_ABI = [
  {
    inputs: [
      { name: 'agentId', type: 'string' },
      { name: 'amount', type: 'uint256' }
    ],
    name: 'tipAgent',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      { name: 'adId', type: 'string' },
      { name: 'amount', type: 'uint256' }
    ],
    name: 'payAd',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  }
] as const;

// Contract addresses (from environment)
export const AGENT_REGISTRY_ADDRESS = (config.AGENT_REGISTRY_ADDRESS || '') as `0x${string}`;
export const CLAWDPAYMENTS_ADDRESS = (config.CLAWDPAYMENTS_ADDRESS || '') as `0x${string}`;

// Public client for reading blockchain data
export const publicClient = createPublicClient({
  chain: bsc,
  transport: http(BSC_RPC_URL)
});

// Wallet client for admin transactions (optional)
let walletClient: ReturnType<typeof createWalletClient> | null = null;
let adminAccount: ReturnType<typeof privateKeyToAccount> | null = null;

if (config.ADMIN_PRIVATE_KEY) {
  adminAccount = privateKeyToAccount(config.ADMIN_PRIVATE_KEY as `0x${string}`);
  walletClient = createWalletClient({
    account: adminAccount,
    chain: bsc,
    transport: http(BSC_RPC_URL)
  });
}

/**
 * Reserve an agent on-chain (admin or authorized wallet)
 */
export async function reserveAgentOnChain(
  agentId: string,
  reservationHash: `0x${string}`,
  expiryTimestamp: bigint,
  authorizedWallet: `0x${string}`
): Promise<`0x${string}`> {
  if (!walletClient || !adminAccount) {
    throw new Error('Admin wallet not configured');
  }

  if (!AGENT_REGISTRY_ADDRESS) {
    throw new Error('AgentRegistry contract address not configured');
  }

  const hash = await walletClient.writeContract({
    address: AGENT_REGISTRY_ADDRESS,
    abi: AGENT_REGISTRY_ABI,
    functionName: 'reserveAgent',
    args: [agentId, reservationHash, expiryTimestamp, authorizedWallet],
    chain: bsc,
    account: adminAccount
  });

  return hash;
}

/**
 * Get agent token ID using agentKeyToTokenId mapping
 */
export async function getAgentTokenId(agentId: string): Promise<bigint> {
  if (!AGENT_REGISTRY_ADDRESS) {
    throw new Error('AgentRegistry contract address not configured');
  }

  // Hash the agentId to get the key (same as contract's _agentKey function)
  const { keccak256, toBytes } = await import('viem');
  const agentKey = keccak256(toBytes(agentId));

  const tokenId = await publicClient.readContract({
    address: AGENT_REGISTRY_ADDRESS,
    abi: AGENT_REGISTRY_ABI,
    functionName: 'agentKeyToTokenId',
    args: [agentKey]
  });

  return tokenId;
}

/**
 * Get payout wallet for token
 */
export async function getPayoutWallet(tokenId: bigint): Promise<`0x${string}`> {
  if (!AGENT_REGISTRY_ADDRESS) {
    throw new Error('AgentRegistry contract address not configured');
  }

  const wallet = await publicClient.readContract({
    address: AGENT_REGISTRY_ADDRESS,
    abi: AGENT_REGISTRY_ABI,
    functionName: 'payoutWallets',
    args: [tokenId]
  });

  return wallet as `0x${string}`;
}

/**
 * Get token owner
 */
export async function getTokenOwner(tokenId: bigint): Promise<`0x${string}`> {
  if (!AGENT_REGISTRY_ADDRESS) {
    throw new Error('AgentRegistry contract address not configured');
  }

  const owner = await publicClient.readContract({
    address: AGENT_REGISTRY_ADDRESS,
    abi: AGENT_REGISTRY_ABI,
    functionName: 'ownerOf',
    args: [tokenId]
  });

  return owner as `0x${string}`;
}

/**
 * Check if agent is verified (blue tick)
 */
export async function isAgentVerified(agentId: string): Promise<boolean> {
  if (!AGENT_REGISTRY_ADDRESS) {
    return false;
  }

  const verified = await publicClient.readContract({
    address: AGENT_REGISTRY_ADDRESS,
    abi: AGENT_REGISTRY_ABI,
    functionName: 'isAgentVerified',
    args: [agentId]
  });

  return verified;
}

/**
 * Check if agent is fully verified (gold tick)
 */
export async function isAgentFullyVerified(agentId: string): Promise<boolean> {
  if (!AGENT_REGISTRY_ADDRESS) {
    return false;
  }

  const fullyVerified = await publicClient.readContract({
    address: AGENT_REGISTRY_ADDRESS,
    abi: AGENT_REGISTRY_ABI,
    functionName: 'isAgentFullyVerified',
    args: [agentId]
  });

  return fullyVerified;
}

/**
 * Parse TipSent events for ranking system
 */
export async function getTipEvents(
  fromBlock: bigint,
  toBlock: bigint
): Promise<Array<{
  agentId: string;
  tipper: `0x${string}`;
  amount: bigint;
  blockNumber: bigint;
}>> {
  if (!CLAWDPAYMENTS_ADDRESS) {
    return [];
  }

  const logs = await publicClient.getLogs({
    address: CLAWDPAYMENTS_ADDRESS,
    event: {
      type: 'event',
      name: 'TipSent',
      inputs: [
        { indexed: true, name: 'agentId', type: 'string' },
        { indexed: true, name: 'tipper', type: 'address' },
        { indexed: false, name: 'amount', type: 'uint256' },
        { indexed: false, name: 'agentShare', type: 'uint256' },
        { indexed: false, name: 'platformShare', type: 'uint256' },
        { indexed: false, name: 'agentPayoutWallet', type: 'address' }
      ]
    },
    fromBlock,
    toBlock
  });

  return logs.map((log) => ({
    agentId: log.args.agentId || '',
    tipper: log.args.tipper || ('0x0' as `0x${string}`),
    amount: log.args.amount || 0n,
    blockNumber: log.blockNumber
  }));
}

/**
 * Format USDC amount for display
 */
export function formatUSDC(amount: bigint): string {
  return formatUnits(amount, USDC_DECIMALS);
}

/**
 * Parse USDC amount from string
 */
export function parseUSDC(amount: string): bigint {
  return parseUnits(amount, USDC_DECIMALS);
}

/**
 * Generate reservation hash
 */
export function generateReservationHash(agentId: string, secret: string): `0x${string}` {
  // Using dynamic import is not suitable for synchronous function
  // Keep require for crypto as it's a Node.js built-in
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256')
    .update(`${agentId}:${secret}`)
    .digest('hex');
  return `0x${hash}` as `0x${string}`;
}