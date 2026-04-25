import { useEffect, useMemo, useRef } from 'react';
import { useSelector } from 'react-redux';
import { Hex, hexToBigInt, isStrictHexString } from '@metamask/utils';
import { TransactionStatus } from '@metamask/transaction-controller';
import { getConfidentialTokensForChain } from '../../shared/lib/confidential-erc7984/registry';
import { selectEvmAddress } from '../selectors/accounts';
import { getEnabledChainIds } from '../selectors';
import { getTransactions } from '../selectors/transactions';
import { confidentialErc7984GetBalanceHandle } from '../store/actions';
import {
  confidentialRevealedRowKey,
  invalidateStaleRevealsAfterHandleRefetch,
} from '../helpers/confidential-erc7984-revealed-storage';

type RefetchRow = {
  key: string;
  chainIdHex: Hex;
  tokenAddress: string;
};

type TxLike = {
  id?: string;
  status?: TransactionStatus | string;
  chainId?: string;
  txParams?: { from?: string; to?: string };
};

/**
 * Refresh the confidential **handle** snapshot for affected rows whenever the user
 * confirms an on-chain action against a confidential-wrapper contract — wrap, unwrap,
 * `finalizeUnwrap`, confidential transfer.
 *
 * This mirrors the way MetaMask's regular Tokens tab feels "instant" after a send:
 * we listen to `TransactionController` (via Redux) for confirmed transactions and
 * re-read `confidentialBalanceOf` for the affected token only, dropping cached cleartext
 * if the on-chain handle changed.
 *
 * Strictly **event-driven** — no `setInterval`, no per-tab pollers competing with
 * MetaMask's own RPC schedule.
 *
 * Mount on:
 *  - the Shielded sub-tab (where cached cleartext is rendered)
 *  - the unwrap-track page (so the snapshot is fresh when the user returns to Shielded)
 */
export function useConfidentialHandleCacheSync(enabled: boolean) {
  const evmAddress = useSelector(selectEvmAddress);
  const enabledChainIds = useSelector(getEnabledChainIds) as Hex[];
  const transactions = useSelector(getTransactions) as TxLike[] | undefined;
  const handledTxIdsRef = useRef<Set<string>>(new Set());
  const baselineDoneRef = useRef(false);

  const enabledHexList = useMemo(
    () => enabledChainIds.filter((id) => isStrictHexString(id)) as Hex[],
    [enabledChainIds],
  );

  const allRows = useMemo((): RefetchRow[] => {
    if (!evmAddress) {
      return [];
    }
    const out: RefetchRow[] = [];
    for (const chainIdHex of enabledHexList) {
      const n = Number(hexToBigInt(chainIdHex));
      for (const token of getConfidentialTokensForChain(n)) {
        out.push({
          key: confidentialRevealedRowKey(
            evmAddress,
            chainIdHex,
            token.address,
          ),
          chainIdHex,
          tokenAddress: token.address,
        });
      }
    }
    return out;
  }, [evmAddress, enabledHexList]);

  /** Lowercase set of registered confidential-wrapper addresses, keyed by lowercase chainId. */
  const tokenSetByChain = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const chainIdHex of enabledHexList) {
      const n = Number(hexToBigInt(chainIdHex));
      const tokens = getConfidentialTokensForChain(n);
      m.set(
        chainIdHex.toLowerCase(),
        new Set(tokens.map((t) => t.address.toLowerCase())),
      );
    }
    return m;
  }, [enabledHexList]);

  /**
   * Baseline check on (re)mount: if the user closed the popup with cleartext
   * displayed, then any on-chain change since last mount means the snapshot
   * needs a one-shot refresh. Re-runs only when the *set of rows* changes
   * (new chain enabled, account switched, etc.).
   */
  useEffect(() => {
    if (!enabled || !evmAddress || allRows.length === 0) {
      baselineDoneRef.current = false;
      return;
    }
    if (baselineDoneRef.current) {
      return;
    }
    baselineDoneRef.current = true;
    void invalidateStaleRevealsAfterHandleRefetch(
      allRows,
      confidentialErc7984GetBalanceHandle,
      evmAddress as string,
    );
  }, [allRows, enabled, evmAddress]);

  /**
   * Event-driven sync: every time MetaMask reports a *confirmed* transaction
   * sent **from** the active address **to** one of our confidential-wrapper
   * contracts, refresh that row's snapshot and drop stale cleartext.
   */
  useEffect(() => {
    if (!enabled || !evmAddress || !transactions?.length) {
      return;
    }
    const lowerFrom = evmAddress.toLowerCase();
    const newRows: RefetchRow[] = [];
    const seenRowKeys = new Set<string>();
    for (const tx of transactions) {
      const id = tx?.id;
      const status = tx?.status;
      const chainId = tx?.chainId;
      const params = tx?.txParams;
      if (!id || !chainId || !params?.from || !params?.to) {
        continue;
      }
      if (status !== TransactionStatus.confirmed) {
        continue;
      }
      if (params.from.toLowerCase() !== lowerFrom) {
        continue;
      }
      if (handledTxIdsRef.current.has(id)) {
        continue;
      }
      const tokenSet = tokenSetByChain.get(chainId.toLowerCase());
      if (!tokenSet?.has(params.to.toLowerCase())) {
        handledTxIdsRef.current.add(id);
        continue;
      }
      handledTxIdsRef.current.add(id);
      const rowKey = confidentialRevealedRowKey(
        evmAddress,
        chainId as Hex,
        params.to,
      );
      if (seenRowKeys.has(rowKey)) {
        continue;
      }
      seenRowKeys.add(rowKey);
      newRows.push({
        key: rowKey,
        chainIdHex: chainId as Hex,
        tokenAddress: params.to,
      });
    }
    if (newRows.length === 0) {
      return;
    }
    void invalidateStaleRevealsAfterHandleRefetch(
      newRows,
      confidentialErc7984GetBalanceHandle,
      evmAddress as string,
    );
  }, [enabled, evmAddress, transactions, tokenSetByChain]);
}
