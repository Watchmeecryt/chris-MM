import React, { useCallback, useEffect, useState } from 'react';
import browser from 'webextension-polyfill';
import {
  Box,
  BoxBorderColor,
  BoxFlexDirection,
  Button,
  ButtonVariant,
  Text,
  TextColor,
  TextVariant,
} from '@metamask/design-system-react';
import { Hex, hexToBigInt } from '@metamask/utils';
import {
  canonicalStringify,
  toTypedDataV4Params,
} from '../../../../shared/lib/confidential-erc7984/eip712';
import {
  cleartextFromUserDecryptResult,
  relayerUserDecryptCompleteForChain,
  relayerUserDecryptPrepareForChain,
} from '../../../../shared/lib/confidential-erc7984/relayer';
import { stringifyBalance } from '../../../hooks/useTokenBalances';
import { useI18nContext } from '../../../hooks/useI18nContext';
import {
  confidentialErc7984GetBalanceHandle,
  confidentialErc7984SignTypedDataV4,
} from '../../../store/actions';
import { CONFIDENTIAL_ZERO_HANDLE } from '../../../../shared/lib/confidential-erc7984/registry';
import {
  addPendingDecryptRow,
  clearConfidentialRevealedRow,
  CONFIDENTIAL_PENDING_DECRYPT_AT_KEY,
  CONFIDENTIAL_PENDING_DECRYPT_KEY,
  CONFIDENTIAL_REVEALED_BALANCES_KEY,
  CONFIDENTIAL_REVEALED_HANDLE_SNAPSHOT_KEY,
  confidentialRevealedRowKey,
  loadConfidentialRevealedBalances,
  loadPendingDecryptRows,
  loadRevealedHandleSnapshots,
  pruneStalePendingDecryptRows,
  removePendingDecryptRow,
  saveConfidentialRevealedDisplay,
} from '../../../helpers/confidential-erc7984-revealed-storage';

const ZERO_HANDLE = CONFIDENTIAL_ZERO_HANDLE;

type ConfidentialErc7984BalancePanelProps = {
  chainId: Hex;
  tokenAddress: string;
  accountAddress: string;
  decimals: number;
  symbol: string;
};

export function ConfidentialErc7984BalancePanel({
  chainId,
  tokenAddress,
  accountAddress,
  decimals,
  symbol,
}: ConfidentialErc7984BalancePanelProps) {
  const t = useI18nContext();
  const chainIdNumber = Number(hexToBigInt(chainId));
  const [handleHex, setHandleHex] = useState<string | null>(null);
  const [handleError, setHandleError] = useState<string | null>(null);
  const [handleLoading, setHandleLoading] = useState(true);

  const [decryptedDisplay, setDecryptedDisplay] = useState<string | null>(null);
  const [decryptError, setDecryptError] = useState<string | null>(null);
  const [decrypting, setDecrypting] = useState(false);

  const storageRowKey = confidentialRevealedRowKey(
    accountAddress,
    chainId,
    tokenAddress,
  );

  useEffect(() => {
    let cancelled = false;

    const syncFromStorage = async () => {
      await pruneStalePendingDecryptRows();
      const [revealed, pending, snapshots] = await Promise.all([
        loadConfidentialRevealedBalances(),
        loadPendingDecryptRows(),
        loadRevealedHandleSnapshots(),
      ]);
      if (cancelled) {
        return;
      }
      const disp = revealed[storageRowKey];
      const snap = snapshots[storageRowKey];
      const h = handleHex?.toLowerCase() ?? null;
      if (disp && h && snap !== undefined && snap !== h) {
        await clearConfidentialRevealedRow(storageRowKey);
        if (!cancelled) {
          setDecryptedDisplay(null);
          setDecrypting(Boolean(pending[storageRowKey]));
        }
        return;
      }
      if (disp) {
        setDecryptedDisplay(disp);
      } else {
        setDecryptedDisplay(null);
      }
      setDecrypting(Boolean(pending[storageRowKey]) && !disp);
    };

    syncFromStorage();

    const onStorageChanged: Parameters<
      typeof browser.storage.onChanged.addListener
    >[0] = (changes, area) => {
      if (area !== 'local') {
        return;
      }
      if (
        !changes[CONFIDENTIAL_REVEALED_BALANCES_KEY] &&
        !changes[CONFIDENTIAL_PENDING_DECRYPT_KEY] &&
        !changes[CONFIDENTIAL_PENDING_DECRYPT_AT_KEY] &&
        !changes[CONFIDENTIAL_REVEALED_HANDLE_SNAPSHOT_KEY]
      ) {
        return;
      }
      syncFromStorage();
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        syncFromStorage();
      }
    };

    browser.storage.onChanged.addListener(onStorageChanged);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', syncFromStorage);

    return () => {
      cancelled = true;
      browser.storage.onChanged.removeListener(onStorageChanged);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', syncFromStorage);
    };
  }, [storageRowKey, handleHex]);

  useEffect(() => {
    let cancelled = false;
    setHandleLoading(true);
    setHandleError(null);
    confidentialErc7984GetBalanceHandle(
      chainId,
      tokenAddress,
      accountAddress,
    )
      .then((h) => {
        if (!cancelled) {
          setHandleHex(h);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setHandleError(e?.message ?? 'Could not read confidential balance.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setHandleLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chainId, tokenAddress, accountAddress]);

  const onReveal = useCallback(async () => {
    if (!handleHex || handleHex.toLowerCase() === ZERO_HANDLE) {
      return;
    }
    setDecryptError(null);
    await addPendingDecryptRow(storageRowKey);
    setDecrypting(true);
    try {
      const freshHandle = await confidentialErc7984GetBalanceHandle(
        chainId,
        tokenAddress,
        accountAddress,
      );
      if (!freshHandle || freshHandle.toLowerCase() === ZERO_HANDLE.toLowerCase()) {
        throw new Error('No confidential balance to decrypt.');
      }
      setHandleHex(freshHandle);
      const prepare = await relayerUserDecryptPrepareForChain(
        { handles: [freshHandle], contractAddresses: [tokenAddress] },
        chainIdNumber,
      );
      const typedData = toTypedDataV4Params(
        prepare.eip712 as Record<string, unknown>,
      );
      const typedDataJsonString = canonicalStringify(typedData);
      const signature = await confidentialErc7984SignTypedDataV4(
        chainId,
        accountAddress,
        typedDataJsonString,
      );
      const result = await relayerUserDecryptCompleteForChain(
        {
          requestId: prepare.requestId,
          signature,
          userAddress: accountAddress,
        },
        chainIdNumber,
      );
      const amount = cleartextFromUserDecryptResult(result, freshHandle);
      const display = stringifyBalance(amount.toString(), decimals);
      await saveConfidentialRevealedDisplay(storageRowKey, display, freshHandle);
      setDecryptedDisplay(display);
    } catch (e) {
      await removePendingDecryptRow(storageRowKey);
      const rawMsg = e instanceof Error ? e.message : String(e);
      const isGatewayNotReady =
        /not ready for decryption|gateway chain|503|response_timed_out/i.test(
          rawMsg,
        );
      setDecryptError(
        isGatewayNotReady
          ? t('privateBalanceDecryptGatewayNotReady')
          : rawMsg || t('privateBalanceDecryptFailed'),
      );
    } finally {
      const [revealed, pending] = await Promise.all([
        loadConfidentialRevealedBalances(),
        loadPendingDecryptRows(),
      ]);
      const disp = revealed[storageRowKey];
      if (disp) {
        setDecryptedDisplay(disp);
      }
      setDecrypting(Boolean(pending[storageRowKey]) && !disp);
    }
  }, [
    accountAddress,
    chainId,
    chainIdNumber,
    decimals,
    handleHex,
    storageRowKey,
    t,
    tokenAddress,
  ]);

  const hasNonZeroHandle =
    handleHex && handleHex.toLowerCase() !== ZERO_HANDLE.toLowerCase();

  return (
    <Box
      flexDirection={BoxFlexDirection.Column}
      gap={2}
      padding={3}
      borderColor={BoxBorderColor.BorderMuted}
      className="rounded-lg border border-solid"
    >
      {handleLoading ? (
        <Text variant={TextVariant.BodySm} color={TextColor.TextAlternative}>
          {t('privateBalanceDecrypting')}
        </Text>
      ) : null}
      {handleError ? (
        <Text variant={TextVariant.BodySm} color={TextColor.ErrorDefault}>
          {handleError}
        </Text>
      ) : null}
      {!handleLoading && !handleError && !hasNonZeroHandle ? (
        <Text variant={TextVariant.BodyMd} color={TextColor.TextDefault}>
          0 {symbol}
        </Text>
      ) : null}
      {decrypting ? (
        <Text variant={TextVariant.BodySm} color={TextColor.TextDefault}>
          {t('privateBalanceDecryptInProgress')}
        </Text>
      ) : null}
      {decryptedDisplay ? (
        <Text variant={TextVariant.BodyMd} color={TextColor.TextDefault}>
          {decryptedDisplay} {symbol}
        </Text>
      ) : null}
      {decryptError ? (
        <Text variant={TextVariant.BodySm} color={TextColor.ErrorDefault}>
          {decryptError}
        </Text>
      ) : null}
      {hasNonZeroHandle ? (
        <Button
          variant={ButtonVariant.Primary}
          disabled={decrypting}
          aria-busy={decrypting ? true : undefined}
          onClick={onReveal}
        >
          {decrypting
            ? t('privateBalanceDecrypting')
            : t('privateBalanceReveal')}
        </Button>
      ) : null}
    </Box>
  );
}
