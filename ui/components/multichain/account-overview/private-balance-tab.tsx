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
  confidentialRevealedRowKey,
  invalidateStaleRevealsAfterHandleRefetch,
  loadBalanceMaskedMap,
  loadConfidentialRevealedBalances,
  loadPendingDecryptRows,
  pruneStalePendingDecryptRows,
  removePendingDecryptRow,
  saveConfidentialRevealedDisplay,
  setBalancesMaskedForKeys,
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

  /** Registry rows only — live handles are refetched like zpayy `confBalance.refetch()` (no auto EIP-712). */
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
  const [batchDecryptPending, setBatchDecryptPending] = useState(false);
  const [batchDecryptError, setBatchDecryptError] = useState<string | null>(
    null,
  );
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

  const refetchHandlesAndInvalidateReveals = useCallback(
    async (rows: HoldingRow[]) => {
      if (!evmAddress || rows.length === 0) {
        return;
      }
      await invalidateStaleRevealsAfterHandleRefetch(
        rows.map((r) => ({
          key: r.key,
          chainIdHex: r.chainIdHex,
          tokenAddress: r.token.address,
        })),
        confidentialErc7984GetBalanceHandle,
        evmAddress as string,
      );
    },
    [evmAddress],
  );

  const schedulePostShieldHandleRefresh = useCallback(
    (row: HoldingRow) => {
      shieldHandleRefreshTimeoutsRef.current.forEach(clearTimeout);
      shieldHandleRefreshTimeoutsRef.current = [];
      const delays = [0, 2500, 8000, 20000, 45000];
      for (const ms of delays) {
        const id = setTimeout(() => {
          void refetchHandlesAndInvalidateReveals([row]);
        }, ms);
        shieldHandleRefreshTimeoutsRef.current.push(id);
      }
    },
    [refetchHandlesAndInvalidateReveals],
  );

  useEffect(() => {
    if (!evmAddress || holdings.length === 0) {
      return undefined;
    }
    const POLL_MS = 12_000;
    const run = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      void refetchHandlesAndInvalidateReveals(holdings);
    };
    const id = setInterval(run, POLL_MS);
    document.addEventListener('visibilitychange', run);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', run);
    };
  }, [evmAddress, holdings, refetchHandlesAndInvalidateReveals]);

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

  /**
   * Batch user-decrypt: one `prepare` + one EIP-712 signature + one `complete` per chain.
   * Requires proxy `userDecrypt` to use `handleContractPairs` (each handle with its token contract).
   */
  const onDecryptAllBalances = useCallback(async () => {
    if (!evmAddress || batchDecryptPending) {
      return;
    }
    setBatchDecryptError(null);
    setBatchDecryptPending(true);
    try {
      const targets = holdings.filter((h) => !decryptByKey[h.key]?.display);
      if (targets.length === 0) {
        setBatchDecryptError(t('privateBalanceDecryptAllNoneNeeded'));
        return;
      }
      const withHandles: { row: HoldingRow; handle: string }[] = [];
      for (const row of targets) {
        try {
          const h = await confidentialErc7984GetBalanceHandle(
            row.chainIdHex,
            row.token.address,
            evmAddress as string,
          );
          if (
            h &&
            h.toLowerCase() !== CONFIDENTIAL_ZERO_HANDLE.toLowerCase()
          ) {
            withHandles.push({ row, handle: h });
          }
        } catch {
          /* skip row — RPC */
        }
      }
      if (withHandles.length === 0) {
        setBatchDecryptError(t('privateBalanceDecryptAllNoBalances'));
        return;
      }
      const byChain = new Map<number, { row: HoldingRow; handle: string }[]>();
      for (const item of withHandles) {
        const n = Number(hexToBigInt(item.row.chainIdHex));
        const list = byChain.get(n) ?? [];
        list.push(item);
        byChain.set(n, list);
      }
      const chainIds = Array.from(byChain.keys()).sort((a, b) => a - b);
      for (const chainIdNumber of chainIds) {
        const items = byChain.get(chainIdNumber) ?? [];
        if (items.length === 0) {
          continue;
        }
        const chainIdHex = items[0].row.chainIdHex;
        for (const { row } of items) {
          await addPendingDecryptRow(row.key);
          setDecryptByKey((prev) => ({
            ...prev,
            [row.key]: {
              display: prev[row.key]?.display ?? null,
              error: null,
              pending: true,
              masked: prev[row.key]?.masked,
            },
          }));
        }
        try {
          const handles = items.map((i) => i.handle);
          const contractAddresses = items.map((i) => i.row.token.address);
          const prepare = await relayerUserDecryptPrepareForChain(
            { handles, contractAddresses },
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
          for (const { row, handle } of items) {
            try {
              const amount = cleartextFromUserDecryptResult(result, handle);
              const display = stringifyBalance(
                amount.toString(),
                row.token.decimals,
              );
              await saveConfidentialRevealedDisplay(row.key, display, handle);
              setDecryptByKey((prev) => ({
                ...prev,
                [row.key]: {
                  display,
                  error: null,
                  pending: false,
                  masked: false,
                },
              }));
            } catch (e) {
              await removePendingDecryptRow(row.key);
              const rawMsg = e instanceof Error ? e.message : String(e);
              setDecryptByKey((prev) => ({
                ...prev,
                [row.key]: {
                  display: prev[row.key]?.display ?? null,
                  error: rawMsg,
                  pending: false,
                  masked: prev[row.key]?.masked,
                },
              }));
            }
          }
        } catch (e) {
          const rawMsg = e instanceof Error ? e.message : String(e);
          const isGatewayNotReady =
            /not ready for decryption|gateway chain|503|response_timed_out/i.test(
              rawMsg,
            );
          const errorMessage = isGatewayNotReady
            ? t('privateBalanceDecryptGatewayNotReady')
            : rawMsg || t('privateBalanceDecryptFailed');
          for (const { row } of items) {
            await removePendingDecryptRow(row.key);
            setDecryptByKey((prev) => ({
              ...prev,
              [row.key]: {
                display: prev[row.key]?.display ?? null,
                error: errorMessage,
                pending: false,
                masked: prev[row.key]?.masked,
              },
            }));
          }
        }
      }
    } finally {
      setBatchDecryptPending(false);
    }
  }, [batchDecryptPending, decryptByKey, evmAddress, holdings, t]);

  /** One control for all revealed rows: hide cleartext everywhere or show again (persists in one storage write). */
  const onToggleAllRevealedVisibility = useCallback(async () => {
    let rowKeys: string[] = [];
    let nextMasked = false;

    setDecryptByKey((prev) => {
      rowKeys = holdings
        .filter((h) => Boolean(prev[h.key]?.display))
        .map((h) => h.key);
      if (rowKeys.length === 0) {
        return prev;
      }
      const anyUnmasked = rowKeys.some((k) => !prev[k]?.masked);
      nextMasked = anyUnmasked;
      const next = { ...prev };
      for (const k of rowKeys) {
        const cur = next[k];
        if (cur) {
          next[k] = { ...cur, masked: nextMasked };
        }
      }
      return next;
    });

    if (rowKeys.length === 0) {
      return;
    }

    try {
      await setBalancesMaskedForKeys(rowKeys, nextMasked);
    } catch {
      setDecryptByKey((prev) => {
        const next = { ...prev };
        const revertMasked = !nextMasked;
        for (const k of rowKeys) {
          const cur = next[k];
          if (cur) {
            next[k] = { ...cur, masked: revertMasked };
          }
        }
        return next;
      });
    }
  }, [holdings]);

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

  const revealedRowKeys = holdings.filter((h) =>
    Boolean(decryptByKey[h.key]?.display),
  );
  const canDecryptMore = holdings.some((h) => !decryptByKey[h.key]?.display);
  const anyRevealedUnmasked = revealedRowKeys.some(
    (h) => !decryptByKey[h.key]?.masked,
  );

  return (
    <>
      <Box
        flexDirection={BoxFlexDirection.Column}
        gap={3}
        padding={4}
        className="private-balance-tab"
      >
        <Box
          flexDirection={BoxFlexDirection.Row}
          flexWrap="wrap"
          gap={2}
          className="w-full items-center justify-between"
        >
          {privateBalanceListBannerText ? (
            <Text
              variant={TextVariant.BodySm}
              color={TextColor.TextDefault}
              className="min-w-0 flex-1"
            >
              {privateBalanceListBannerText}
            </Text>
          ) : (
            <Box className="min-w-0 flex-1" />
          )}
          <Box
            flexDirection={BoxFlexDirection.Row}
            gap={2}
            className="shrink-0 items-center"
          >
            {revealedRowKeys.length > 0 ? (
              <Button
                variant={ButtonVariant.Secondary}
                onClick={() => void onToggleAllRevealedVisibility()}
                disabled={batchDecryptPending}
                aria-label={
                  anyRevealedUnmasked
                    ? t('privateBalanceHide')
                    : t('privateBalanceShow')
                }
                title={
                  anyRevealedUnmasked
                    ? t('privateBalanceVisibilityHideAllTitle')
                    : t('privateBalanceVisibilityShowAllTitle')
                }
                className="inline-flex h-10 min-w-10 shrink-0 items-center justify-center !px-3"
              >
                <Icon
                  name={
                    anyRevealedUnmasked ? IconName.EyeSlash : IconName.Eye
                  }
                  size={IconSize.Sm}
                  color={IconColor.iconDefault}
                />
              </Button>
            ) : null}
            {canDecryptMore ? (
              <Button
                variant={ButtonVariant.Primary}
                onClick={() => void onDecryptAllBalances()}
                disabled={batchDecryptPending}
                className="inline-flex shrink-0 flex-row items-center justify-center gap-2"
              >
                <Icon
                  name={IconName.Eye}
                  size={IconSize.Sm}
                  color={IconColor.iconInverse}
                />
                {batchDecryptPending
                  ? t('privateBalanceDecrypting')
                  : t('privateBalanceDecryptAll')}
              </Button>
            ) : null}
          </Box>
        </Box>
        {batchDecryptError ? (
          <Text variant={TextVariant.BodySm} color={TextColor.ErrorDefault}>
            {batchDecryptError}
          </Text>
        ) : null}
        {holdings.map((row) => {
          const d = decryptByKey[row.key];
          const chainName =
            networkConfigurationsByChainId[row.chainIdHex]?.name ??
            row.chainIdHex;
          const hasDisplay = Boolean(d?.display);
          const isMasked = Boolean(d?.masked);
          const rowBusy = Boolean(d?.pending);
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
                <Box className="relative h-9 w-9 shrink-0">
                  {iconSrc ? (
                    <img
                      src={iconSrc}
                      alt=""
                      width={36}
                      height={36}
                      className="h-9 w-9 rounded-full object-cover"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                      }}
                    />
                  ) : (
                    <Box
                      className="flex h-9 w-9 items-center justify-center rounded-full border border-muted bg-muted text-xs font-medium uppercase"
                      title={row.token.symbol}
                    >
                      <Text
                        variant={TextVariant.BodyXs}
                        color={TextColor.TextAlternative}
                      >
                        {row.token.symbol.slice(0, 2)}
                      </Text>
                    </Box>
                  )}
                  <Box
                    className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-muted bg-background-default shadow-sm"
                    title={t('privateBalanceConfidentialBadgeTitle')}
                  >
                    <Icon
                      name={IconName.Lock}
                      size={IconSize.Xs}
                      color={IconColor.iconDefault}
                    />
                  </Box>
                </Box>
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
                    isMasked
                      ? t('privateBalanceMaskedPlaceholder')
                      : d.display,
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
                  variant={ButtonVariant.Secondary}
                  disabled={rowBusy}
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
                  disabled={rowBusy}
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
