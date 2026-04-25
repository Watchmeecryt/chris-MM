import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useLocation, useNavigate } from 'react-router-dom';
import { encodeFunctionData } from 'viem';
import {
  TransactionStatus,
  TransactionType,
} from '@metamask/transaction-controller';
import { Hex, hexToBigInt } from '@metamask/utils';
import { FINALIZE_UNWRAP_ABI } from '../../../../shared/lib/confidential-erc7984/abi';
import { parseBurntHandleFromReceiptLogs } from '../../../../shared/lib/confidential-erc7984/unwrap-receipt';
import { relayerPublicDecryptProofForHandleWithRetry } from '../../../../shared/lib/confidential-erc7984/relayer';
import { useI18nContext } from '../../../hooks/useI18nContext';
import { selectEvmAddress } from '../../../selectors/accounts';
import { getTransactionsByChainId } from '../../../selectors/transactions';
import {
  CONFIRM_TRANSACTION_ROUTE,
  DEFAULT_ROUTE,
  PRIVATE_BALANCE_UNWRAP_TRACK_ROUTE,
} from '../../../helpers/constants/routes';
import {
  addTransaction,
  confidentialErc7984GetTransactionReceipt,
  findNetworkClientIdByChainId,
  forceUpdateMetamaskState,
} from '../../../store/actions';
import type { MetaMaskReduxDispatch } from '../../../store/store';
import {
  clearPrivateBalanceUnwrapFinalizeSession,
  mergePrivateBalanceUnwrapFinalizeSession,
  readPrivateBalanceUnwrapFinalizeSession,
  txMetaBroadcastHash,
  type PrivateBalanceUnwrapFinalizeSession,
} from '../../../helpers/private-balance-unwrap-session';

type FinalizeStage =
  | 'idle'
  | 'waiting-confirmation'
  | 'fetching-receipt'
  | 'decrypting'
  | 'submitting'
  | 'failed';

const TERMINAL_FAIL = new Set([
  TransactionStatus.failed,
  TransactionStatus.rejected,
  TransactionStatus.dropped,
  'cancelled',
]);

/**
 * Drives the **unwrap → finalize** flow on `/private-balance/unwrap-track`.
 *
 * Design:
 *  - **No `setInterval`, no block scanner, no buttons.**
 *  - Subscribes to MetaMask's `TransactionController` via Redux. When the unwrap meta
 *    transitions to `confirmed`, we run **one** receipt fetch + relayer public decrypt +
 *    `addTransaction` for `finalizeUnwrap` and route to the confirmation screen.
 *  - On `focus` / `visibilitychange` we ask the background to flush its state patches
 *    (`forceUpdateMetamaskState`). This is what nudges the popup's Redux state to catch
 *    up on whatever the controller has already learned, without us re-polling RPC
 *    ourselves.
 */
export function usePrivateBalanceUnwrapFinalizePoller(enabled: boolean): {
  unwrapFinalizeHint: string | null;
  setUnwrapFinalizeHint: (hint: string | null) => void;
} {
  const t = useI18nContext();
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useDispatch<MetaMaskReduxDispatch>();
  const evmAddress = useSelector(selectEvmAddress);

  const [session, setSession] =
    useState<PrivateBalanceUnwrapFinalizeSession | null>(() =>
      readPrivateBalanceUnwrapFinalizeSession(),
    );
  const [stage, setStage] = useState<FinalizeStage>('idle');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const lockRef = useRef(false);
  const handledMetaIdRef = useRef<string | null>(null);

  /**
   * Pick up a session that was written by `shield-page` while we were navigating —
   * a `localStorage` write from another script does fire `storage`. We also re-read
   * on `focus` (popup reopen) and ask the background to flush its state patches so
   * Redux reflects the latest controller state.
   */
  useEffect(() => {
    const sync = () => {
      const next = readPrivateBalanceUnwrapFinalizeSession();
      setSession(next);
      handledMetaIdRef.current = null;
      setRetryNonce((n) => n + 1);
      void forceUpdateMetamaskState(dispatch).catch(() => {
        /* offscreen / background not ready */
      });
    };
    sync();
    window.addEventListener('storage', sync);
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [dispatch]);

  const transactions = useSelector((state) =>
    session ? getTransactionsByChainId(state, session.chainIdHex) : null,
  ) as Array<Record<string, unknown>> | null;

  const unwrapMeta = useMemo(() => {
    if (!session || !transactions) {
      return null;
    }
    return (
      transactions.find(
        (tx) =>
          (tx as { id?: string }).id &&
          (tx as { id?: string }).id === session.unwrapTxMetaId,
      ) ?? null
    );
  }, [session, transactions]);

  const unwrapStatus = (unwrapMeta as { status?: string } | null)?.status as
    | TransactionStatus
    | string
    | undefined;
  const unwrapHashFromMeta =
    (session?.unwrapTxHash as string | undefined) ??
    (unwrapMeta ? txMetaBroadcastHash(unwrapMeta) : null);

  /** Persist hash if MM finally exposes it. */
  useEffect(() => {
    if (!session || session.unwrapTxHash || !unwrapHashFromMeta) {
      return;
    }
    mergePrivateBalanceUnwrapFinalizeSession({
      unwrapTxHash: unwrapHashFromMeta,
    });
    setSession(readPrivateBalanceUnwrapFinalizeSession());
  }, [session, unwrapHashFromMeta]);

  const runFinalize = useCallback(async () => {
    if (!session || !evmAddress) {
      return;
    }
    if (lockRef.current) {
      return;
    }
    if (handledMetaIdRef.current === session.unwrapTxMetaId) {
      return;
    }
    if (session.evmAddress.toLowerCase() !== evmAddress.toLowerCase()) {
      return;
    }
    const txHash = session.unwrapTxHash ?? unwrapHashFromMeta ?? null;
    if (!txHash) {
      return;
    }
    lockRef.current = true;
    handledMetaIdRef.current = session.unwrapTxMetaId ?? null;
    try {
      setErrorText(null);
      setStage('fetching-receipt');
      const receipt = await confidentialErc7984GetTransactionReceipt(
        session.chainIdHex,
        txHash,
      );
      if (!receipt) {
        setStage('waiting-confirmation');
        handledMetaIdRef.current = null;
        return;
      }
      const ok =
        receipt.status === '0x1' ||
        receipt.status === '0x01' ||
        receipt.status === 1 ||
        String(receipt.status).toLowerCase() === 'success';
      if (!ok) {
        clearPrivateBalanceUnwrapFinalizeSession();
        setSession(null);
        setStage('failed');
        setErrorText(t('privateBalanceUnwrapFinalizeFailed'));
        return;
      }

      const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
      const burntHandle = parseBurntHandleFromReceiptLogs(
        logs,
        session.tokenAddress,
      );
      if (!burntHandle) {
        clearPrivateBalanceUnwrapFinalizeSession();
        setSession(null);
        setStage('failed');
        setErrorText(t('privateBalanceUnwrapFinalizeFailed'));
        return;
      }

      setStage('decrypting');
      const chainIdNumber = Number(hexToBigInt(session.chainIdHex));
      const proof = await relayerPublicDecryptProofForHandleWithRetry(
        burntHandle,
        chainIdNumber,
      );
      if (!proof) {
        setStage('failed');
        setErrorText(t('privateBalanceUnwrapFinalizeFailed'));
        handledMetaIdRef.current = null;
        return;
      }

      const MAX_UINT64 = 18446744073709551615n;
      const clearU64 =
        proof.cleartext >= 0n && proof.cleartext <= MAX_UINT64
          ? proof.cleartext
          : 0n;
      const data = encodeFunctionData({
        abi: FINALIZE_UNWRAP_ABI,
        functionName: 'finalizeUnwrap',
        args: [burntHandle, clearU64, proof.decryptionProof],
      });

      setStage('submitting');
      const networkClientId = await findNetworkClientIdByChainId(
        session.chainIdHex,
      );
      const finalizeMeta = await addTransaction(
        {
          from: session.evmAddress as Hex,
          to: session.tokenAddress as Hex,
          data: data as Hex,
          value: '0x0' as Hex,
          chainId: session.chainIdHex,
        },
        {
          networkClientId,
          type: TransactionType.contractInteraction,
        },
      );

      clearPrivateBalanceUnwrapFinalizeSession();
      setSession(null);
      const goBackAfterFinalize =
        location.pathname === PRIVATE_BALANCE_UNWRAP_TRACK_ROUTE
          ? DEFAULT_ROUTE
          : `${location.pathname}${location.search}`;
      navigate({
        pathname: `${CONFIRM_TRANSACTION_ROUTE}/${finalizeMeta.id}`,
        search: new URLSearchParams({
          goBackTo: goBackAfterFinalize,
        }).toString(),
      });
    } catch (err) {
      setStage('failed');
      setErrorText(
        err instanceof Error
          ? err.message
          : t('privateBalanceUnwrapFinalizeFailed'),
      );
      handledMetaIdRef.current = null;
    } finally {
      lockRef.current = false;
    }
  }, [
    evmAddress,
    location.pathname,
    location.search,
    navigate,
    session,
    t,
    unwrapHashFromMeta,
  ]);

  useEffect(() => {
    if (!enabled || !session || !evmAddress) {
      setStage('idle');
      return;
    }
    if (!unwrapMeta && !session.unwrapTxHash) {
      setStage('waiting-confirmation');
      return;
    }
    const status = String(unwrapStatus ?? '').toLowerCase();
    if (TERMINAL_FAIL.has(status)) {
      clearPrivateBalanceUnwrapFinalizeSession();
      setSession(null);
      setStage('failed');
      setErrorText(t('privateBalanceUnwrapFinalizeFailed'));
      return;
    }
    if (status === TransactionStatus.confirmed) {
      void runFinalize();
      return;
    }
    setStage('waiting-confirmation');
  }, [
    enabled,
    evmAddress,
    retryNonce,
    runFinalize,
    session,
    t,
    unwrapMeta,
    unwrapStatus,
  ]);

  const hint = useMemo(() => {
    if (errorText) {
      return errorText;
    }
    switch (stage) {
      case 'waiting-confirmation':
        return t('privateBalanceUnwrapFinalizeWaiting');
      case 'fetching-receipt':
        return t('privateBalanceUnwrapTrackFindingOnChain');
      case 'decrypting':
        return t('privateBalanceUnwrapFinalizeDecrypting');
      case 'submitting':
        return t('privateBalanceUnwrapFinalizeSubmitting');
      case 'failed':
        return t('privateBalanceUnwrapFinalizeFailed');
      default:
        return null;
    }
  }, [errorText, stage, t]);

  const setHintFromOutside = useCallback((next: string | null) => {
    setErrorText(next);
    if (!next) {
      setStage((prev) => (prev === 'failed' ? 'idle' : prev));
    }
  }, []);

  return {
    unwrapFinalizeHint: hint,
    setUnwrapFinalizeHint: setHintFromOutside,
  };
}
