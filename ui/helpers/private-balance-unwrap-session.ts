import type { Hex } from '@metamask/utils';

export const PRIVATE_BALANCE_UNWRAP_FINALIZE_SESSION_KEY =
  'privateBalanceErc7984UnwrapFinalizeSession';

/** @deprecated Removed from writes; cleared on Private balance mount so old builds do not resurrect stale state. */
export const LEGACY_PRIVATE_BALANCE_UNWRAP_LOCAL_KEY =
  'privateBalanceErc7984UnwrapFinalizeSessionLocal';

export type PrivateBalanceUnwrapFinalizeSession = {
  /** MetaMask transaction id (preferred until we have an on-chain hash). */
  unwrapTxMetaId?: string;
  /**
   * Unwrap tx hash — receipt polling uses this so we are not blocked on `getTransaction` shape.
   */
  unwrapTxHash?: string;
  /**
   * `txParams.nonce` when the unwrap was queued — used to recover the real hash on-chain if MM stays on "Signing".
   */
  unwrapTxNonce?: string;
  chainIdHex: Hex;
  tokenAddress: string;
  evmAddress: string;
};

/** Best-effort hash from a `TransactionMeta` object returned by `addTransaction` / `getTransaction`. */
export function txMetaBroadcastHash(tx: unknown): string | null {
  if (!tx || typeof tx !== 'object') {
    return null;
  }
  const m = tx as Record<string, unknown>;
  const txParams = m.txParams as Record<string, unknown> | undefined;
  const txReceipt = m.txReceipt as Record<string, unknown> | undefined;
  const candidates = [
    m.hash,
    m.transactionHash,
    txReceipt?.transactionHash,
    txParams?.hash,
  ];
  for (const h of candidates) {
    if (
      typeof h === 'string' &&
      h.startsWith('0x') &&
      /^0x[0-9a-fA-F]{64}$/.test(h)
    ) {
      return h;
    }
  }
  return null;
}

function validateSession(
  v: PrivateBalanceUnwrapFinalizeSession,
): PrivateBalanceUnwrapFinalizeSession | null {
  const hasId =
    typeof v.unwrapTxMetaId === 'string' && v.unwrapTxMetaId.length > 0;
  const hasHash =
    typeof v.unwrapTxHash === 'string' &&
    v.unwrapTxHash.startsWith('0x') &&
    v.unwrapTxHash.length === 66;
  const hasNonce =
    typeof v.unwrapTxNonce === 'string' && v.unwrapTxNonce.length > 0;
  if (!hasId && !hasHash && !hasNonce) {
    return null;
  }
  if (
    typeof v.chainIdHex !== 'string' ||
    typeof v.tokenAddress !== 'string' ||
    typeof v.evmAddress !== 'string'
  ) {
    return null;
  }
  return v;
}

/**
 * Session-only: lives in `sessionStorage` for this popup document only.
 * Closing the extension popup clears it — no `browser.storage.local` persistence.
 */
export function savePrivateBalanceUnwrapFinalizeSession(
  s: PrivateBalanceUnwrapFinalizeSession,
): void {
  const normalized = validateSession(s);
  if (!normalized) {
    return;
  }
  const json = JSON.stringify(normalized);
  try {
    sessionStorage.setItem(PRIVATE_BALANCE_UNWRAP_FINALIZE_SESSION_KEY, json);
  } catch {
    /* quota / private mode */
  }
}

export function mergePrivateBalanceUnwrapFinalizeSession(
  patch: Partial<PrivateBalanceUnwrapFinalizeSession>,
): void {
  const cur = readPrivateBalanceUnwrapFinalizeSession();
  if (!cur) {
    return;
  }
  savePrivateBalanceUnwrapFinalizeSession({ ...cur, ...patch });
}

export function readPrivateBalanceUnwrapFinalizeSession(): PrivateBalanceUnwrapFinalizeSession | null {
  try {
    const raw = sessionStorage.getItem(
      PRIVATE_BALANCE_UNWRAP_FINALIZE_SESSION_KEY,
    );
    if (!raw) {
      return null;
    }
    const v = JSON.parse(raw) as PrivateBalanceUnwrapFinalizeSession;
    return validateSession(v);
  } catch {
    /* ignore */
  }
  return null;
}

export function clearPrivateBalanceUnwrapFinalizeSession(): void {
  try {
    sessionStorage.removeItem(PRIVATE_BALANCE_UNWRAP_FINALIZE_SESSION_KEY);
  } catch {
    /* ignore */
  }
}
