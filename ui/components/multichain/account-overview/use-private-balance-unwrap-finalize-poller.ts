import { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { useLocation, useNavigate } from 'react-router-dom';
import { encodeFunctionData } from 'viem';
import { TransactionType } from '@metamask/transaction-controller';
import { Hex, hexToBigInt } from '@metamask/utils';
import { FINALIZE_UNWRAP_ABI } from '../../../../shared/lib/confidential-erc7984/abi';
import { parseBurntHandleFromReceiptLogs } from '../../../../shared/lib/confidential-erc7984/unwrap-receipt';
import { relayerPublicDecryptProofForHandleWithRetry } from '../../../../shared/lib/confidential-erc7984/relayer';
import { useI18nContext } from '../../../hooks/useI18nContext';
import { selectEvmAddress } from '../../../selectors/accounts';
import { CONFIRM_TRANSACTION_ROUTE } from '../../../helpers/constants/routes';
import {
  addTransaction,
  confidentialErc7984FindPublishedTransactionHash,
  confidentialErc7984GetTransactionReceipt,
  findNetworkClientIdByChainId,
  getTransactionById,
} from '../../../store/actions';
import {
  clearPrivateBalanceUnwrapFinalizeSession,
  mergePrivateBalanceUnwrapFinalizeSession,
  readPrivateBalanceUnwrapFinalizeSession,
  txMetaBroadcastHash,
} from '../../../helpers/private-balance-unwrap-session';

/**
 * ERC-7984 unwrap finalize must keep polling while the user is on any home tab
 * (Tokens, Activity, etc.). Tab content is unmounted when inactive, so this hook
 * lives on {@link AccountOverviewTabs}, which stays mounted.
 */
export function usePrivateBalanceUnwrapFinalizePoller(enabled: boolean): {
  unwrapFinalizeHint: string | null;
  setUnwrapFinalizeHint: (hint: string | null) => void;
} {
  const t = useI18nContext();
  const navigate = useNavigate();
  const location = useLocation();
  const evmAddress = useSelector(selectEvmAddress);
  const [unwrapFinalizeHint, setUnwrapFinalizeHint] = useState<string | null>(
    null,
  );
  const unwrapFinalizeLockRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setUnwrapFinalizeHint(null);
      return undefined;
    }
    if (!evmAddress) {
      return undefined;
    }

    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;

    const terminalFail = new Set([
      'failed',
      'rejected',
      'cancelled',
      'dropped',
    ]);

    const receiptSucceeded = (status: unknown) => {
      if (status === undefined || status === null) {
        return false;
      }
      if (typeof status === 'number') {
        return status === 1;
      }
      if (typeof status === 'bigint') {
        return status === 1n;
      }
      if (typeof status === 'boolean') {
        return status === true;
      }
      const s = String(status).toLowerCase();
      return (
        s === '0x1' || s === '0x01' || s === '1' || s === 'success'
      );
    };

    const tick = async () => {
      if (cancelled || unwrapFinalizeLockRef.current) {
        return;
      }
      const session = readPrivateBalanceUnwrapFinalizeSession();
      if (!session) {
        if (!cancelled) {
          setUnwrapFinalizeHint(null);
        }
        return;
      }
      if (session.evmAddress.toLowerCase() !== evmAddress.toLowerCase()) {
        clearPrivateBalanceUnwrapFinalizeSession();
        return;
      }

      unwrapFinalizeLockRef.current = true;
      try {
        setUnwrapFinalizeHint(t('privateBalanceUnwrapFinalizeWaiting'));

        let txHash = session.unwrapTxHash ?? null;
        let txFromMeta: Awaited<
          ReturnType<typeof getTransactionById>
        > | undefined;

        if (!txHash && session.unwrapTxMetaId) {
          txFromMeta = await getTransactionById(session.unwrapTxMetaId);
          if (
            txFromMeta?.status &&
            terminalFail.has(String(txFromMeta.status))
          ) {
            clearPrivateBalanceUnwrapFinalizeSession();
            setUnwrapFinalizeHint(null);
            return;
          }
          txHash = txMetaBroadcastHash(txFromMeta);
          if (txHash) {
            mergePrivateBalanceUnwrapFinalizeSession({ unwrapTxHash: txHash });
          }
        }

        const nonceForLookup =
          session.unwrapTxNonce ?? txFromMeta?.txParams?.nonce;
        if (txFromMeta?.txParams?.nonce && !session.unwrapTxNonce) {
          mergePrivateBalanceUnwrapFinalizeSession({
            unwrapTxNonce: txFromMeta.txParams.nonce,
          });
        }
        if (!txHash && nonceForLookup) {
          try {
            const recovered =
              await confidentialErc7984FindPublishedTransactionHash(
                session.chainIdHex,
                session.evmAddress,
                session.tokenAddress,
                nonceForLookup,
              );
            if (recovered) {
              txHash = recovered;
              mergePrivateBalanceUnwrapFinalizeSession({
                unwrapTxHash: recovered,
              });
            }
          } catch {
            /* RPC / network — retry next tick */
          }
        }

        if (!txHash) {
          return;
        }

        const receipt = await confidentialErc7984GetTransactionReceipt(
          session.chainIdHex,
          txHash,
        );
        if (!receipt) {
          return;
        }
        if (!receiptSucceeded(receipt.status)) {
          clearPrivateBalanceUnwrapFinalizeSession();
          setUnwrapFinalizeHint(null);
          return;
        }

        const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
        const burntHandle = parseBurntHandleFromReceiptLogs(
          logs,
          session.tokenAddress,
        );
        if (!burntHandle) {
          clearPrivateBalanceUnwrapFinalizeSession();
          setUnwrapFinalizeHint(null);
          return;
        }

        setUnwrapFinalizeHint(t('privateBalanceUnwrapFinalizeDecrypting'));
        const chainIdNumber = Number(hexToBigInt(session.chainIdHex));
        const proof = await relayerPublicDecryptProofForHandleWithRetry(
          burntHandle,
          chainIdNumber,
        );
        if (cancelled) {
          return;
        }
        if (!proof) {
          clearPrivateBalanceUnwrapFinalizeSession();
          setUnwrapFinalizeHint(null);
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

        setUnwrapFinalizeHint(t('privateBalanceUnwrapFinalizeSubmitting'));
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
        if (!cancelled) {
          setUnwrapFinalizeHint(null);
          navigate({
            pathname: `${CONFIRM_TRANSACTION_ROUTE}/${finalizeMeta.id}`,
            search: new URLSearchParams({
              goBackTo: location.pathname + location.search,
            }).toString(),
          });
        }
      } catch {
        clearPrivateBalanceUnwrapFinalizeSession();
        if (!cancelled) {
          setUnwrapFinalizeHint(null);
        }
      } finally {
        unwrapFinalizeLockRef.current = false;
      }
    };

    intervalId = setInterval(() => {
      tick().catch(() => {
        /* non-fatal */
      });
    }, 2500);
    tick().catch(() => {
      /* non-fatal */
    });

    return () => {
      cancelled = true;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [
    enabled,
    evmAddress,
    location.pathname,
    location.search,
    navigate,
    t,
  ]);

  return { unwrapFinalizeHint, setUnwrapFinalizeHint };
}
