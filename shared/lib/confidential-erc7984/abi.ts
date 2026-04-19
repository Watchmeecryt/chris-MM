/** Minimal ERC-7984 + ERC-20 fragments — mirrors zWallet `ERC7984_ABI` usage. */

export const CONFIDENTIAL_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'confidentialTransfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'encryptedAmount', type: 'bytes32' },
      { name: 'inputProof', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

export const WRAP_ABI = [
  {
    type: 'function',
    name: 'wrap',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

export const UNWRAP_ABI = [
  {
    type: 'function',
    name: 'unwrap',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'encryptedAmount', type: 'bytes32' },
      { name: 'inputProof', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

/** Second step after `unwrap` mines — same shape as zWallet / zpayy `finalizeUnwrap`. */
export const FINALIZE_UNWRAP_ABI = [
  {
    type: 'function',
    name: 'finalizeUnwrap',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'burntAmount', type: 'bytes32' },
      { name: 'burntAmountCleartext', type: 'uint64' },
      { name: 'decryptionProof', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

/** Emitted by the confidential wrapper when an unwrap is requested (`amount` is the burnt balance handle). */
export const UNWRAP_REQUESTED_EVENT_ABI = [
  {
    type: 'event',
    name: 'UnwrapRequested',
    inputs: [
      { indexed: true, name: 'receiver', type: 'address' },
      { indexed: false, name: 'amount', type: 'bytes32' },
    ],
  },
] as const;

export const ERC20_ALLOWANCE_APPROVE_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;
