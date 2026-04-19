import type { Hex } from '@metamask/utils';
import { decodeEventLog } from 'viem';
import { UNWRAP_REQUESTED_EVENT_ABI } from './abi';

export type ConfidentialUnwrapReceiptLog = {
  address?: string;
  topics?: readonly Hex[];
  data: Hex;
};

/**
 * Reads the burnt confidential-balance handle from `UnwrapRequested` in the unwrap tx receipt
 * (zWallet `parseBurntHandleFromReceipt`).
 */
export function parseBurntHandleFromReceiptLogs(
  logs: readonly ConfidentialUnwrapReceiptLog[],
  confidentialTokenAddress: string,
): Hex | null {
  const tokenLower = confidentialTokenAddress.toLowerCase();
  for (const log of logs) {
    if (!log.address || log.address.toLowerCase() !== tokenLower) {
      continue;
    }
    try {
      if (!log.topics || log.topics.length < 2) {
        continue;
      }
      const decoded = decodeEventLog({
        abi: UNWRAP_REQUESTED_EVENT_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (
        decoded.eventName === 'UnwrapRequested' &&
        decoded.args &&
        'amount' in decoded.args
      ) {
        const amount = decoded.args.amount as string;
        if (
          typeof amount === 'string' &&
          amount.startsWith('0x') &&
          amount.length === 66
        ) {
          return amount as Hex;
        }
      }
    } catch {
      // ignore decode errors
    }
  }
  return null;
}
