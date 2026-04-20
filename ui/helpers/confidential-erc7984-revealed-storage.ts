import browser from 'webextension-polyfill';
import type { Hex } from '@metamask/utils';
import { CONFIDENTIAL_ZERO_HANDLE } from '../../shared/lib/confidential-erc7984/registry';

export const CONFIDENTIAL_REVEALED_BALANCES_KEY = 'confidentialErc7984RevealedBalances';
export const CONFIDENTIAL_PENDING_DECRYPT_KEY = 'confidentialErc7984PendingDecryptRows';
/** `rowKey` → `Date.now()` when decrypt was started; used to drop stuck "Decrypting…" after timeout. */
export const CONFIDENTIAL_PENDING_DECRYPT_AT_KEY = 'confidentialErc7984PendingDecryptAt';
/** Drop pending decrypt UI if older than this (relayer can take ~120s; add margin). */
export const CONFIDENTIAL_PENDING_DECRYPT_STALE_MS = 4 * 60 * 1000;
/** When true, UI shows a masked balance; cleartext remains in {@link CONFIDENTIAL_REVEALED_BALANCES_KEY}. */
export const CONFIDENTIAL_BALANCE_MASKED_KEY = 'confidentialErc7984BalanceMasked';
/** `rowKey` → `confidentialBalanceOf` handle (lowercase hex) saved when cleartext was stored — compared on each refetch to drop stale reveals. */
export const CONFIDENTIAL_REVEALED_HANDLE_SNAPSHOT_KEY =
  'confidentialErc7984RevealedHandleSnapshots';

/** Flat map: `${evmLower}:${chainIdHex}:${tokenLower}` → formatted display string */
export type ConfidentialRevealedBalancesMap = Record<string, string>;

export type ConfidentialPendingDecryptMap = Record<string, boolean>;

export type ConfidentialBalanceMaskedMap = Record<string, boolean>;

export async function loadBalanceMaskedMap(): Promise<ConfidentialBalanceMaskedMap> {
  const { [CONFIDENTIAL_BALANCE_MASKED_KEY]: raw } =
    await browser.storage.local.get(CONFIDENTIAL_BALANCE_MASKED_KEY);
  return (raw as ConfidentialBalanceMaskedMap) ?? {};
}

export async function setBalanceMasked(rowKey: string, masked: boolean): Promise<void> {
  const prev = await loadBalanceMaskedMap();
  const next = { ...prev };
  if (masked) {
    next[rowKey] = true;
  } else {
    delete next[rowKey];
  }
  await browser.storage.local.set({ [CONFIDENTIAL_BALANCE_MASKED_KEY]: next });
}

/**
 * Update mask flags for many rows in one read/write so concurrent per-key updates
 * cannot clobber each other (e.g. global eye toggle with Promise.all).
 */
export async function setBalancesMaskedForKeys(
  rowKeys: string[],
  masked: boolean,
): Promise<void> {
  if (rowKeys.length === 0) {
    return;
  }
  const prev = await loadBalanceMaskedMap();
  const next = { ...prev };
  if (masked) {
    for (const k of rowKeys) {
      next[k] = true;
    }
  } else {
    for (const k of rowKeys) {
      delete next[k];
    }
  }
  await browser.storage.local.set({ [CONFIDENTIAL_BALANCE_MASKED_KEY]: next });
}

export async function loadConfidentialRevealedBalances(): Promise<ConfidentialRevealedBalancesMap> {
  const { [CONFIDENTIAL_REVEALED_BALANCES_KEY]: raw } =
    await browser.storage.local.get(CONFIDENTIAL_REVEALED_BALANCES_KEY);
  return (raw as ConfidentialRevealedBalancesMap) ?? {};
}

export async function loadPendingDecryptRows(): Promise<ConfidentialPendingDecryptMap> {
  const { [CONFIDENTIAL_PENDING_DECRYPT_KEY]: raw } =
    await browser.storage.local.get(CONFIDENTIAL_PENDING_DECRYPT_KEY);
  return (raw as ConfidentialPendingDecryptMap) ?? {};
}

async function loadPendingDecryptStartedAt(): Promise<Record<string, number>> {
  const { [CONFIDENTIAL_PENDING_DECRYPT_AT_KEY]: raw } =
    await browser.storage.local.get(CONFIDENTIAL_PENDING_DECRYPT_AT_KEY);
  return (raw as Record<string, number>) ?? {};
}

/**
 * Removes pending flags that are too old (failed relayer, closed popup, lost error path).
 * Legacy rows with `pending: true` but no timestamp are treated as stale.
 */
export async function pruneStalePendingDecryptRows(): Promise<void> {
  const [pending, atMap] = await Promise.all([
    loadPendingDecryptRows(),
    loadPendingDecryptStartedAt(),
  ]);
  const now = Date.now();
  const nextPending = { ...pending };
  const nextAt = { ...atMap };
  let changed = false;
  for (const k of Object.keys(nextPending)) {
    if (!nextPending[k]) {
      continue;
    }
    const started = nextAt[k];
    const stale =
      started === undefined ||
      Number.isNaN(started) ||
      now - started > CONFIDENTIAL_PENDING_DECRYPT_STALE_MS;
    if (stale) {
      delete nextPending[k];
      delete nextAt[k];
      changed = true;
    }
  }
  if (changed) {
    await browser.storage.local.set({
      [CONFIDENTIAL_PENDING_DECRYPT_KEY]: nextPending,
      [CONFIDENTIAL_PENDING_DECRYPT_AT_KEY]: nextAt,
    });
  }
}

export async function addPendingDecryptRow(rowKey: string): Promise<void> {
  const [prev, atPrev] = await Promise.all([
    loadPendingDecryptRows(),
    loadPendingDecryptStartedAt(),
  ]);
  await browser.storage.local.set({
    [CONFIDENTIAL_PENDING_DECRYPT_KEY]: { ...prev, [rowKey]: true },
    [CONFIDENTIAL_PENDING_DECRYPT_AT_KEY]: { ...atPrev, [rowKey]: Date.now() },
  });
}

export async function removePendingDecryptRow(rowKey: string): Promise<void> {
  const [prev, atPrev] = await Promise.all([
    loadPendingDecryptRows(),
    loadPendingDecryptStartedAt(),
  ]);
  const next = { ...prev };
  const nextAt = { ...atPrev };
  delete next[rowKey];
  delete nextAt[rowKey];
  await browser.storage.local.set({
    [CONFIDENTIAL_PENDING_DECRYPT_KEY]: next,
    [CONFIDENTIAL_PENDING_DECRYPT_AT_KEY]: nextAt,
  });
}

export type ConfidentialRevealedHandleSnapshotsMap = Record<string, string>;

export async function loadRevealedHandleSnapshots(): Promise<ConfidentialRevealedHandleSnapshotsMap> {
  const { [CONFIDENTIAL_REVEALED_HANDLE_SNAPSHOT_KEY]: raw } =
    await browser.storage.local.get(CONFIDENTIAL_REVEALED_HANDLE_SNAPSHOT_KEY);
  return (raw as ConfidentialRevealedHandleSnapshotsMap) ?? {};
}

export type RefetchBalanceHandleRow = {
  key: string;
  chainIdHex: Hex;
  tokenAddress: string;
};

/**
 * zpayy-style `refetch()`: re-read `confidentialBalanceOf` per row; if cleartext is stored and the
 * live handle no longer matches the handle from the last successful decrypt, clear that row (no EIP-712).
 */
export async function invalidateStaleRevealsAfterHandleRefetch(
  rows: RefetchBalanceHandleRow[],
  fetchHandle: (
    chainIdHex: Hex,
    tokenAddress: string,
    account: string,
  ) => Promise<string | null | undefined>,
  account: string,
): Promise<void> {
  const [revealed, handleWhenDecrypted] = await Promise.all([
    loadConfidentialRevealedBalances(),
    loadRevealedHandleSnapshots(),
  ]);
  for (const row of rows) {
    if (!revealed[row.key]) {
      continue;
    }
    let currentLower: string;
    try {
      const h = await fetchHandle(row.chainIdHex, row.tokenAddress, account);
      currentLower = (h ?? CONFIDENTIAL_ZERO_HANDLE).toLowerCase();
    } catch {
      continue;
    }
    const savedLower = handleWhenDecrypted[row.key]?.toLowerCase();
    if (savedLower === undefined || savedLower !== currentLower) {
      await clearConfidentialRevealedRow(row.key);
    }
  }
}

export async function saveConfidentialRevealedDisplay(
  rowKey: string,
  display: string,
  balanceHandleHex: string,
): Promise<void> {
  const prev = await loadConfidentialRevealedBalances();
  const [pending, atPending] = await Promise.all([
    loadPendingDecryptRows(),
    loadPendingDecryptStartedAt(),
  ]);
  const nextPending = { ...pending };
  const nextPendingAt = { ...atPending };
  delete nextPending[rowKey];
  delete nextPendingAt[rowKey];
  const maskedPrev = await loadBalanceMaskedMap();
  const nextMasked = { ...maskedPrev };
  delete nextMasked[rowKey];
  const snapshots = await loadRevealedHandleSnapshots();
  const nextSnapshots = {
    ...snapshots,
    [rowKey]: balanceHandleHex.toLowerCase(),
  };
  await browser.storage.local.set({
    [CONFIDENTIAL_REVEALED_BALANCES_KEY]: { ...prev, [rowKey]: display },
    [CONFIDENTIAL_PENDING_DECRYPT_KEY]: nextPending,
    [CONFIDENTIAL_PENDING_DECRYPT_AT_KEY]: nextPendingAt,
    [CONFIDENTIAL_BALANCE_MASKED_KEY]: nextMasked,
    [CONFIDENTIAL_REVEALED_HANDLE_SNAPSHOT_KEY]: nextSnapshots,
  });
}

/** Clears saved cleartext, pending decrypt, mask, and handle snapshot for one row. */
export async function clearConfidentialRevealedRow(rowKey: string): Promise<void> {
  const [prev, pending, atPending, maskedPrev, snapshots] = await Promise.all([
    loadConfidentialRevealedBalances(),
    loadPendingDecryptRows(),
    loadPendingDecryptStartedAt(),
    loadBalanceMaskedMap(),
    loadRevealedHandleSnapshots(),
  ]);
  const next = { ...prev };
  const nextPending = { ...pending };
  const nextPendingAt = { ...atPending };
  const nextMasked = { ...maskedPrev };
  const nextSnapshots = { ...snapshots };
  delete next[rowKey];
  delete nextPending[rowKey];
  delete nextPendingAt[rowKey];
  delete nextMasked[rowKey];
  delete nextSnapshots[rowKey];
  await browser.storage.local.set({
    [CONFIDENTIAL_REVEALED_BALANCES_KEY]: next,
    [CONFIDENTIAL_PENDING_DECRYPT_KEY]: nextPending,
    [CONFIDENTIAL_PENDING_DECRYPT_AT_KEY]: nextPendingAt,
    [CONFIDENTIAL_BALANCE_MASKED_KEY]: nextMasked,
    [CONFIDENTIAL_REVEALED_HANDLE_SNAPSHOT_KEY]: nextSnapshots,
  });
}

export function confidentialRevealedRowKey(
  evmAddress: string,
  chainIdHex: string,
  tokenAddress: string,
): string {
  return `${evmAddress.toLowerCase()}:${chainIdHex.toLowerCase()}:${tokenAddress.toLowerCase()}`;
}
