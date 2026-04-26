import { toChecksumHexAddress } from '@metamask/controller-utils';
import {
  getRelayerBaseUrlForChainId,
  MAINNET_CHAIN_ID,
  MAINNET_RELAYER_BASE_URL,
  RELAYER_ENDPOINTS,
} from './constants';

function checksumAddress(addr: string): string {
  try {
    return toChecksumHexAddress(addr as `0x${string}`);
  } catch {
    return addr;
  }
}

/** Mainnet: 18-decimal confidential tokens use 6-decimal fixed point for relayer encrypt (per relayer API expectations). */
export function relayerEncryptDecimalsForToken(
  tokenDecimals: number,
  chainId: number,
): number {
  if (chainId === MAINNET_CHAIN_ID && tokenDecimals === 18) {
    return 6;
  }
  return tokenDecimals;
}

export type EncryptAmountParams = {
  contractAddress: string;
  userAddress: string;
  amount: string;
  decimals: number;
};

export type EncryptAmountResult = { handle: string; inputProof: string };

export async function relayerEncryptAmount(
  params: EncryptAmountParams,
  baseUrl: string = MAINNET_RELAYER_BASE_URL,
): Promise<EncryptAmountResult> {
  const res = await fetch(
    `${baseUrl.replace(/\/$/, '')}${RELAYER_ENDPOINTS.encryptAmount}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contractAddress: checksumAddress(params.contractAddress),
        userAddress: checksumAddress(params.userAddress),
        amount: params.amount,
        decimals: params.decimals,
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`relayer encrypt-amount failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { handle?: string; inputProof?: string };
  if (!data.handle || !data.inputProof) {
    throw new Error('relayer encrypt-amount: missing handle or inputProof');
  }
  return { handle: data.handle, inputProof: data.inputProof };
}

export async function relayerEncryptAmountForChain(
  params: EncryptAmountParams,
  chainId: number,
): Promise<EncryptAmountResult> {
  return relayerEncryptAmount(params, getRelayerBaseUrlForChainId(chainId));
}

export async function relayerUserDecryptPrepare(
  params: { handles: string[]; contractAddresses: string[] },
  baseUrl: string = MAINNET_RELAYER_BASE_URL,
): Promise<{ requestId: string; eip712: unknown }> {
  const res = await fetch(
    `${baseUrl.replace(/\/$/, '')}${RELAYER_ENDPOINTS.userDecryptPrepare}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handles: params.handles,
        contractAddresses: params.contractAddresses.map(checksumAddress),
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`relayer user-decrypt/prepare failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { requestId?: string; eip712?: unknown };
  if (!data.requestId || !data.eip712) {
    throw new Error('relayer user-decrypt/prepare: missing requestId or eip712');
  }
  return { requestId: data.requestId, eip712: data.eip712 };
}

export async function relayerUserDecryptPrepareForChain(
  params: { handles: string[]; contractAddresses: string[] },
  chainId: number,
): Promise<{ requestId: string; eip712: unknown }> {
  return relayerUserDecryptPrepare(
    params,
    getRelayerBaseUrlForChainId(chainId),
  );
}

export async function relayerUserDecryptComplete(
  params: { requestId: string; signature: string; userAddress: string },
  baseUrl: string = MAINNET_RELAYER_BASE_URL,
): Promise<Record<string, unknown>> {
  const res = await fetch(
    `${baseUrl.replace(/\/$/, '')}${RELAYER_ENDPOINTS.userDecryptComplete}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: params.requestId,
        signature: params.signature,
        userAddress: checksumAddress(params.userAddress),
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`relayer user-decrypt/complete failed: ${res.status} ${text}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export async function relayerUserDecryptCompleteForChain(
  params: { requestId: string; signature: string; userAddress: string },
  chainId: number,
): Promise<Record<string, unknown>> {
  return relayerUserDecryptComplete(
    params,
    getRelayerBaseUrlForChainId(chainId),
  );
}

export type PublicDecryptResult = {
  decryptionProof?: string;
  clearValues?: Record<string, bigint | number | string>;
};

export async function relayerPublicDecrypt(
  handles: string[],
  baseUrl: string = MAINNET_RELAYER_BASE_URL,
): Promise<PublicDecryptResult> {
  const res = await fetch(
    `${baseUrl.replace(/\/$/, '')}${RELAYER_ENDPOINTS.publicDecrypt}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handles }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`relayer public-decrypt failed: ${res.status} ${text}`);
  }
  return (await res.json()) as PublicDecryptResult;
}

export async function relayerPublicDecryptForChain(
  handles: string[],
  chainId: number,
): Promise<PublicDecryptResult> {
  return relayerPublicDecrypt(handles, getRelayerBaseUrlForChainId(chainId));
}

/**
 * Parse Zama relayer `publicDecrypt` JSON (mainnet proxy shape).
 */
export function cleartextAndProofFromPublicDecrypt(
  result: PublicDecryptResult,
  handle: string,
): { cleartext: bigint; decryptionProof: `0x${string}` } | null {
  const { decryptionProof, clearValues } = result;
  if (!decryptionProof || !clearValues) {
    return null;
  }
  let val: bigint | number | string | undefined = clearValues[handle];
  if (val === undefined) {
    val = clearValues[handle.toLowerCase()];
  }
  if (val === undefined) {
    const keys = Object.keys(clearValues);
    if (keys.length > 0) {
      val = clearValues[keys[0]];
    }
  }
  if (val === undefined) {
    return null;
  }
  const cleartext =
    typeof val === 'bigint' ? val : BigInt(String(Number(val)));
  const proofHex = (
    decryptionProof.startsWith('0x') ? decryptionProof : `0x${decryptionProof}`
  ) as `0x${string}`;
  return { cleartext, decryptionProof: proofHex };
}

const PUBLIC_DECRYPT_MAX_ATTEMPTS = 8;
const PUBLIC_DECRYPT_RETRY_MS = 2000;

export async function relayerPublicDecryptProofForHandleWithRetry(
  handle: string,
  chainId: number,
): Promise<{ cleartext: bigint; decryptionProof: `0x${string}` } | null> {
  for (let i = 0; i < PUBLIC_DECRYPT_MAX_ATTEMPTS; i++) {
    try {
      const raw = await relayerPublicDecryptForChain([handle], chainId);
      const parsed = cleartextAndProofFromPublicDecrypt(raw, handle);
      if (parsed) {
        return parsed;
      }
    } catch {
      // retry
    }
    if (i < PUBLIC_DECRYPT_MAX_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, PUBLIC_DECRYPT_RETRY_MS));
    }
  }
  return null;
}

/**
 * Parse relayer `user-decrypt/complete` JSON — handle-keyed cleartext map
 * `App.tsx` (mainnet) + `zamaRelayer.runUserDecrypt`: `result[handle]`,
 * then `result[handle.toLowerCase()]`, then first cleartext-like value (single handle).
 */
export function cleartextFromUserDecryptResult(
  result: Record<string, unknown>,
  handle: string,
): bigint {
  const maps: Record<string, unknown>[] = [result];
  const inner = result.result;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    maps.push(inner as Record<string, unknown>);
  }

  for (const map of maps) {
    let value: unknown =
      map[handle] ??
      map[handle.toLowerCase()] ??
      undefined;
    if (value === undefined || value === null) {
      value = Object.values(map).find(
        (v) =>
          v !== null &&
          v !== undefined &&
          (typeof v === 'bigint' ||
            typeof v === 'number' ||
            typeof v === 'string'),
      );
    }
    if (value !== undefined && value !== null) {
      if (typeof value === 'bigint') {
        return value;
      }
      if (typeof value === 'number') {
        return BigInt(Math.floor(value));
      }
      return BigInt(String(value));
    }
  }

  throw new Error('Decrypt returned no value for this handle.');
}
