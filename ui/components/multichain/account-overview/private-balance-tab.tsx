import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import browser from 'webextension-polyfill';
import {
  Box,
  BoxFlexDirection,
  Button,
  ButtonVariant,
  Text,
  TextColor,
  TextVariant,
} from '@metamask/design-system-react';
import { Icon, IconName, IconSize } from '../../component-library';
import { IconColor } from '../../../helpers/constants/design-system';
import { Hex, hexToBigInt, isStrictHexString } from '@metamask/utils';
import {
  CONFIDENTIAL_ZERO_HANDLE,
  type ConfidentialTokenDefinition,
  getConfidentialTokensForChain,
} from '../../../../shared/lib/confidential-erc7984/registry';
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
import { selectEvmAddress } from '../../../selectors/accounts';
import { getEnabledChainIds, getTokenList, selectERC20TokensByChain } from '../../../selectors';
import { getMultichainNetworkConfigurationsByChainId } from '../../../selectors/multichain';
import { getCurrentChainId } from '../../../../shared/lib/selectors/networks';
import {
  confidentialErc7984GetBalanceHandle,
  confidentialErc7984SignTypedDataV4,
} from '../../../store/actions';
import {
  addPendingDecryptRow,
  CONFIDENTIAL_BALANCE_MASKED_KEY,
  CONFIDENTIAL_PENDING_DECRYPT_AT_KEY,
  CONFIDENTIAL_PENDING_DECRYPT_KEY,
  CONFIDENTIAL_REVEALED_BALANCES_KEY,
  CONFIDENTIAL_REVEALED_HANDLE_SNAPSHOT_KEY,
  clearConfidentialRevealedRow,
  confidentialRevealedRowKey,
  loadBalanceMaskedMap,
  loadConfidentialRevealedBalances,
  loadPendingDecryptRows,
  loadRevealedHandleSnapshots,
  pruneStalePendingDecryptRows,
  removePendingDecryptRow,
  saveConfidentialRevealedDisplay,
  setBalanceMasked,
} from '../../../helpers/confidential-erc7984-revealed-storage';
import {
  LEGACY_PRIVATE_BALANCE_UNWRAP_LOCAL_KEY,
  clearPrivateBalanceUnwrapFinalizeSession,
} from '../../../helpers/private-balance-unwrap-session';
import { PrivateBalanceSendModal } from './private-balance-send-modal';
import { PrivateBalanceWrapModal } from './private-balance-wrap-modal';

export type PrivateBalanceTabProps = {
  unwrapFinalizeHint: string | null;
  setUnwrapFinalizeHint: (hint: string | null) => void;
};

type HoldingRow = {
  key: string;
  chainIdHex: Hex;
  token: ConfidentialTokenDefinition;
  handleHex: string;
};

type DecryptRowState = {
  display: string | null;
  error: string | null;
  pending: boolean;
  /** When true, show a masked balance; cleartext stays in extension storage. */
  masked?: boolean;
};

export function PrivateBalanceTab({
  unwrapFinalizeHint,
  setUnwrapFinalizeHint,
}: PrivateBalanceTabProps) {
  const t = useI18nContext();
  const evmAddress = useSelector(selectEvmAddress);
  const enabledChainIds = useSelector(getEnabledChainIds) as Hex[];
  const networkConfigurationsByChainId = useSelector(
    getMultichainNetworkConfigurationsByChainId,
  );
  const erc20TokensByChain = useSelector(selectERC20TokensByChain);
  const tokenList = useSelector(getTokenList);
  const currentChainId = useSelector(getCurrentChainId);

  const enabledHexList = useMemo(
    () => enabledChainIds.filter((id) => isStrictHexString(id)) as Hex[],
    [enabledChainIds.join(',')],
  );

  /** Registry rows only — no background handle scan. Handles are read on decrypt / wrap / snapshot check. */
  const holdings = useMemo((): HoldingRow[] => {
    if (!evmAddress) {
      return [];
    }
    const rows: HoldingRow[] = [];
    for (const chainIdHex of enabledHexList) {
      const n = Number(hexToBigInt(chainIdHex));
      for (const token of getConfidentialTokensForChain(n)) {
        rows.push({
          key: confidentialRevealedRowKey(
            evmAddress,
            chainIdHex,
            token.address,
          ),
          chainIdHex,
          token,
          handleHex: CONFIDENTIAL_ZERO_HANDLE,
        });
      }
    }
    return rows;
  }, [evmAddress, enabledHexList]);

  /**
   * Same sources as the asset page (`token-asset.tsx`): per-chain token cache, then aggregated token list.
   * Uses the confidential wrapper’s *underlying* public ERC-20 so icons match the Tokens tab.
   */
  const confidentialTokenIconByRowKey = useMemo(() => {
    const map: Record<string, string | undefined> = {};
    for (const row of holdings) {
      const underlying = row.token.underlyingAddress;
      if (!underlying) {
        continue;
      }
      const u = underlying.toLowerCase();
      const fromChain =
        erc20TokensByChain?.[row.chainIdHex]?.data?.[u]?.iconUrl;
      if (fromChain) {
        map[row.key] = fromChain;
        continue;
      }
      if (row.chainIdHex === currentChainId) {
        const direct = (tokenList as Record<string, { iconUrl?: string }>)?.[
          u
        ]?.iconUrl;
        if (direct) {
          map[row.key] = direct;
          continue;
        }
      }
      const fromList = Object.values(
        (tokenList ?? {}) as Record<
          string,
          { address?: string; iconUrl?: string }
        >,
      ).find(
        (entry) =>
          typeof entry?.address === 'string' &&
          entry.address.toLowerCase() === u,
      )?.iconUrl;
      if (fromList) {
        map[row.key] = fromList;
      }
    }
    return map;
  }, [holdings, erc20TokensByChain, tokenList, currentChainId]);

  const [decryptByKey, setDecryptByKey] = useState<
    Record<string, DecryptRowState>
  >({});
  const [sendForRow, setSendForRow] = useState<HoldingRow | null>(null);
  const [wrapTarget, setWrapTarget] = useState<{
    row: HoldingRow;
    tab: 0 | 1;
  } | null>(null);
  const [shieldTabBanner, setShieldTabBanner] = useState<string | null>(null);
  const shieldHandleRefreshTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>(
    [],
  );

  /** Drop legacy unwrap automation keys so they cannot interfere with signing / UI. */
  useEffect(() => {
    void browser.storage.local.remove([
      'confidentialErc7984PendingUnwrapFinalizeV2',
      'confidentialErc7984WrapModalResume',
    ]);
  }, []);

  /** Older builds persisted finalize session in local storage; remove so it cannot resurrect after refresh. */
  useEffect(() => {
    void browser.storage.local.remove(LEGACY_PRIVATE_BALANCE_UNWRAP_LOCAL_KEY);
  }, []);

  const openWrapForRow = useCallback(
    (row: HoldingRow) => {
      if (!evmAddress) {
        return;
      }
      clearPrivateBalanceUnwrapFinalizeSession();
      setUnwrapFinalizeHint(null);
      setWrapTarget({ row, tab: 0 });
    },
    [evmAddress, setUnwrapFinalizeHint],
  );

  const invalidateStaleRevealIfHandleChanged = useCallback(
    async (row: HoldingRow) => {
      if (!evmAddress) {
        return;
      }
      const k = row.key;
      const snapshots = await loadRevealedHandleSnapshots();
      const snap = snapshots[k];
      if (snap === undefined) {
        return;
      }
      try {
        const h = await confidentialErc7984GetBalanceHandle(
          row.chainIdHex,
          row.token.address,
          evmAddress,
        );
        const cur = (h ?? CONFIDENTIAL_ZERO_HANDLE).toLowerCase();
        if (snap !== cur) {
          await clearConfidentialRevealedRow(k);
        }
      } catch {
        /* RPC — retry on next scheduled tick */
      }
    },
    [evmAddress],
  );

  const schedulePostShieldHandleRefresh = useCallback(
    (row: HoldingRow) => {
      shieldHandleRefreshTimeoutsRef.current.forEach(clearTimeout);
      shieldHandleRefreshTimeoutsRef.current = [];
      const delays = [0, 4000, 12000, 25000];
      for (const ms of delays) {
        const id = setTimeout(() => {
          void invalidateStaleRevealIfHandleChanged(row);
        }, ms);
        shieldHandleRefreshTimeoutsRef.current.push(id);
      }
    },
    [invalidateStaleRevealIfHandleChanged],
  );

  useEffect(() => {
    return () => {
      shieldHandleRefreshTimeoutsRef.current.forEach(clearTimeout);
    };
  }, []);

  /**
   * Signature / navigation can destroy or suspend this UI before `setState` runs.
   * Storage + onChanged + focus sync keeps decrypting + revealed values aligned.
   */
  useEffect(() => {
    if (!evmAddress) {
      return;
    }
    let cancelled = false;
    const prefix = `${evmAddress.toLowerCase()}:`;

    const mergeDecryptFromStorage = async () => {
      await pruneStalePendingDecryptRows();
      const [revealed, pendingRows, maskedMap] = await Promise.all([
        loadConfidentialRevealedBalances(),
        loadPendingDecryptRows(),
        loadBalanceMaskedMap(),
      ]);
      if (cancelled) {
        return;
      }
      setDecryptByKey((prev) => {
        const rest = Object.fromEntries(
          Object.entries(prev).filter(([k]) => !k.startsWith(prefix)),
        );
        const next: Record<string, DecryptRowState> = { ...rest };

        for (const k of Object.keys(pendingRows)) {
          if (!k.startsWith(prefix) || !pendingRows[k]) {
            continue;
          }
          if (revealed[k]) {
            continue;
          }
          next[k] = {
            display: prev[k]?.display ?? null,
            error: null,
            pending: true,
            masked: prev[k]?.masked ?? Boolean(maskedMap[k]),
          };
        }
        for (const [k, display] of Object.entries(revealed)) {
          if (!k.startsWith(prefix)) {
            continue;
          }
          next[k] = {
            display,
            error: null,
            pending: false,
            masked: Boolean(maskedMap[k]),
          };
        }
        for (const [k, v] of Object.entries(prev)) {
          if (!k.startsWith(prefix) || next[k]) {
            continue;
          }
          next[k] = v;
        }
        return next;
      });
    };

    mergeDecryptFromStorage();

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
        !changes[CONFIDENTIAL_BALANCE_MASKED_KEY] &&
        !changes[CONFIDENTIAL_REVEALED_HANDLE_SNAPSHOT_KEY]
      ) {
        return;
      }
      mergeDecryptFromStorage();
    };

    const onBecameVisible = () => {
      if (document.visibilityState === 'visible') {
        mergeDecryptFromStorage();
      }
    };

    browser.storage.onChanged.addListener(onStorageChanged);
    document.addEventListener('visibilitychange', onBecameVisible);
    window.addEventListener('focus', mergeDecryptFromStorage);

    return () => {
      cancelled = true;
      browser.storage.onChanged.removeListener(onStorageChanged);
      document.removeEventListener('visibilitychange', onBecameVisible);
      window.removeEventListener('focus', mergeDecryptFromStorage);
    };
  }, [evmAddress]);

  useEffect(() => {
    if (!evmAddress) {
      return;
    }
    let cancelled = false;
    const prefix = `${evmAddress.toLowerCase()}:`;

    const run = async () => {
      const revealed = await loadConfidentialRevealedBalances();
      const snapshots = await loadRevealedHandleSnapshots();
      for (const k of Object.keys(revealed)) {
        if (!k.startsWith(prefix)) {
          continue;
        }
        const row = holdings.find((h) => h.key === k);
        if (!row) {
          if (!cancelled) {
            await clearConfidentialRevealedRow(k);
          }
          continue;
        }
        let curHandle: string;
        try {
          const h = await confidentialErc7984GetBalanceHandle(
            row.chainIdHex,
            row.token.address,
            evmAddress,
          );
          curHandle = h ?? CONFIDENTIAL_ZERO_HANDLE;
        } catch {
          continue;
        }
        if (cancelled) {
          return;
        }
        const snap = snapshots[k];
        const cur = curHandle.toLowerCase();
        if (snap !== undefined && snap !== cur) {
          await clearConfidentialRevealedRow(k);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [evmAddress, holdings]);

  const onReveal = useCallback(
    async (row: HoldingRow) => {
      const { key, chainIdHex, token } = row;
      const chainIdNumber = Number(hexToBigInt(chainIdHex));
      await addPendingDecryptRow(key);
      setDecryptByKey((prev) => ({
        ...prev,
        [key]: {
          display: prev[key]?.display ?? null,
          error: null,
          pending: true,
          masked: prev[key]?.masked,
        },
      }));
      try {
        const freshHandle = await confidentialErc7984GetBalanceHandle(
          chainIdHex,
          token.address,
          evmAddress as string,
        );
        if (
          !freshHandle ||
          freshHandle.toLowerCase() === CONFIDENTIAL_ZERO_HANDLE.toLowerCase()
        ) {
          throw new Error('No confidential balance to decrypt.');
        }
        const prepare = await relayerUserDecryptPrepareForChain(
          { handles: [freshHandle], contractAddresses: [token.address] },
          chainIdNumber,
        );
        const typedData = toTypedDataV4Params(
          prepare.eip712 as Record<string, unknown>,
        );
        const typedDataJsonString = canonicalStringify(typedData);
        const signature = await confidentialErc7984SignTypedDataV4(
          chainIdHex,
          evmAddress as string,
          typedDataJsonString,
        );
        const result = await relayerUserDecryptCompleteForChain(
          {
            requestId: prepare.requestId,
            signature,
            userAddress: evmAddress as string,
          },
          chainIdNumber,
        );
        const amount = cleartextFromUserDecryptResult(result, freshHandle);
        const display = stringifyBalance(amount.toString(), token.decimals);
        await saveConfidentialRevealedDisplay(key, display, freshHandle);
        setDecryptByKey((prev) => ({
          ...prev,
          [key]: { display, error: null, pending: false, masked: false },
        }));
      } catch (e) {
        await removePendingDecryptRow(key);
        const rawMsg = e instanceof Error ? e.message : String(e);
        const isGatewayNotReady =
          /not ready for decryption|gateway chain|503|response_timed_out/i.test(
            rawMsg,
          );
        const errorMessage = isGatewayNotReady
          ? t('privateBalanceDecryptGatewayNotReady')
          : rawMsg || t('privateBalanceDecryptFailed');
        setDecryptByKey((prev) => ({
          ...prev,
          [key]: {
            display: prev[key]?.display ?? null,
            error: errorMessage,
            pending: false,
            masked: prev[key]?.masked,
          },
        }));
      }
    },
    [evmAddress, t],
  );

  const onToggleBalanceMask = useCallback(async (rowKey: string, masked: boolean) => {
    await setBalanceMasked(rowKey, masked);
    setDecryptByKey((prev) => {
      const cur = prev[rowKey];
      if (!cur) {
        return prev;
      }
      return {
        ...prev,
        [rowKey]: { ...cur, masked },
      };
    });
  }, []);

  if (!evmAddress) {
    return (
      <Box padding={4}>
        <Text variant={TextVariant.BodyMd} color={TextColor.TextAlternative}>
          {t('privateBalanceEvmOnly')}
        </Text>
      </Box>
    );
  }

  if (holdings.length === 0) {
    return (
      <Box padding={4} flexDirection={BoxFlexDirection.Column} gap={2}>
        <Text variant={TextVariant.BodyMd} color={TextColor.TextDefault}>
          {t('privateBalanceEmptyTitle')}
        </Text>
        <Text variant={TextVariant.BodySm} color={TextColor.TextAlternative}>
          {t('privateBalanceEmptyDescription')}
        </Text>
      </Box>
    );
  }

  const privateBalanceListBannerText =
    wrapTarget?.tab === 0 ? shieldTabBanner : unwrapFinalizeHint;

  return (
    <>
      <Box
        flexDirection={BoxFlexDirection.Column}
        gap={3}
        padding={4}
        className="private-balance-tab"
      >
        <Text variant={TextVariant.BodySm} color={TextColor.TextAlternative}>
          {t('privateBalanceIntro')}
        </Text>
        {privateBalanceListBannerText ? (
          <Text variant={TextVariant.BodySm} color={TextColor.TextDefault}>
            {privateBalanceListBannerText}
          </Text>
        ) : null}
        {holdings.map((row) => {
          const d = decryptByKey[row.key];
          const chainName =
            networkConfigurationsByChainId[row.chainIdHex]?.name ??
            row.chainIdHex;
          const hasDisplay = Boolean(d?.display);
          const isMasked = Boolean(d?.masked);
          const primaryDecryptLabel = d?.pending
            ? t('privateBalanceDecrypting')
            : hasDisplay
              ? isMasked
                ? t('privateBalanceShow')
                : t('privateBalanceHide')
              : t('privateBalanceReveal');
          const onPrimaryDecrypt = () => {
            if (d?.pending) {
              return;
            }
            if (!hasDisplay) {
              onReveal(row);
              return;
            }
            onToggleBalanceMask(row.key, !isMasked);
          };
          const decryptActionIcon = d?.pending
            ? IconName.Clock
            : !hasDisplay
              ? IconName.Eye
              : isMasked
                ? IconName.Eye
                : IconName.EyeSlash;
          const iconSrc = confidentialTokenIconByRowKey[row.key];
          return (
            <Box
              key={row.key}
              flexDirection={BoxFlexDirection.Column}
              gap={2}
              padding={3}
              className="rounded-lg border border-muted"
            >
              <Box
                flexDirection={BoxFlexDirection.Row}
                gap={3}
                className="items-center"
              >
                {iconSrc ? (
                  <img
                    src={iconSrc}
                    alt=""
                    width={36}
                    height={36}
                    className="rounded-full shrink-0 object-cover"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                ) : null}
                <Text variant={TextVariant.BodyMd} color={TextColor.TextDefault}>
                  {row.token.symbol} · {chainName}
                </Text>
              </Box>
              <Text variant={TextVariant.BodySm} color={TextColor.TextAlternative}>
                {t('privateBalanceEncryptedHint')}
              </Text>
              {d?.pending ? (
                <Text variant={TextVariant.BodySm} color={TextColor.TextDefault}>
                  {t('privateBalanceDecryptInProgress')}
                </Text>
              ) : null}
              {hasDisplay ? (
                <Text variant={TextVariant.BodyMd} color={TextColor.TextDefault}>
                  {t('privateBalanceRevealed', [
                    isMasked ? t('privateBalanceMaskedPlaceholder') : d.display,
                    row.token.symbol,
                  ])}
                </Text>
              ) : null}
              {d?.error ? (
                <Text variant={TextVariant.BodySm} color={TextColor.ErrorDefault}>
                  {d.error}
                </Text>
              ) : null}
              <Box flexDirection={BoxFlexDirection.Row} gap={2} flexWrap="wrap">
                <Button
                  variant={ButtonVariant.Primary}
                  disabled={Boolean(d?.pending)}
                  aria-busy={d?.pending ? true : undefined}
                  onClick={onPrimaryDecrypt}
                  className="inline-flex flex-row items-center justify-center gap-2"
                >
                  <Icon
                    name={decryptActionIcon}
                    size={IconSize.Sm}
                    color={IconColor.iconInverse}
                  />
                  {primaryDecryptLabel}
                </Button>
                <Button
                  variant={ButtonVariant.Secondary}
                  disabled={Boolean(d?.pending)}
                  onClick={() => setSendForRow(row)}
                  className="inline-flex flex-row items-center justify-center gap-2"
                >
                  <Icon
                    name={IconName.Send}
                    size={IconSize.Sm}
                    color={IconColor.iconAlternative}
                  />
                  {t('privateBalanceSend')}
                </Button>
                <Button
                  variant={ButtonVariant.Secondary}
                  disabled={Boolean(d?.pending)}
                  onClick={() => openWrapForRow(row)}
                  className="inline-flex flex-row items-center justify-center gap-2"
                >
                  <Icon
                    name={IconName.ShieldLock}
                    size={IconSize.Sm}
                    color={IconColor.iconAlternative}
                  />
                  {t('privateBalanceWrapOpen')}
                </Button>
              </Box>
            </Box>
          );
        })}
      </Box>
      {sendForRow ? (
        <PrivateBalanceSendModal
          isOpen
          onClose={() => setSendForRow(null)}
          evmAddress={evmAddress as string}
          chainIdHex={sendForRow.chainIdHex}
          token={sendForRow.token}
        />
      ) : null}
      {wrapTarget ? (
        <PrivateBalanceWrapModal
          isOpen
          onClose={() => {
            setShieldTabBanner(null);
            setUnwrapFinalizeHint(null);
            setWrapTarget(null);
          }}
          evmAddress={evmAddress as string}
          chainIdHex={wrapTarget.row.chainIdHex}
          token={wrapTarget.row.token}
          initialTab={wrapTarget.tab}
          onShieldTabBannerChange={setShieldTabBanner}
          onShieldTransactionQueued={() =>
            schedulePostShieldHandleRefresh(wrapTarget.row)
          }
        />
      ) : null}
    </>
  );
}
