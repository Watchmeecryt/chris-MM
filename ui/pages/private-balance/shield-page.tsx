import React, { useCallback, useEffect, useState } from 'react';
import log from 'loglevel';
import { useSelector } from 'react-redux';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import type { Hex } from '@metamask/utils';
import { hexToBigInt } from '@metamask/utils';
import {
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  maxUint256,
  parseUnits,
} from 'viem';
import {
  TransactionType,
  type TransactionMeta,
} from '@metamask/transaction-controller';
import {
  AlignItems,
  BackgroundColor,
  BlockSize,
  BorderRadius,
  Display,
  FlexDirection,
  JustifyContent,
  TextVariant,
} from '../../helpers/constants/design-system';
import {
  Box,
  ButtonIcon,
  ButtonIconSize,
  ButtonPrimary,
  ButtonSecondary,
  FormTextField,
  IconName,
  Text,
} from '../../components/component-library';
import { ScrollContainer } from '../../contexts/scroll-container';
import {
  ERC20_ALLOWANCE_APPROVE_ABI,
  UNWRAP_ABI,
  WRAP_ABI,
} from '../../../shared/lib/confidential-erc7984/abi';
import {
  getUnderlyingPublicDisplaySymbol,
  type ConfidentialTokenDefinition,
} from '../../../shared/lib/confidential-erc7984/registry';
import {
  relayerEncryptAmountForChain,
  relayerEncryptDecimalsForToken,
} from '../../../shared/lib/confidential-erc7984/relayer';
import {
  CONFIRM_TRANSACTION_ROUTE,
  DEFAULT_ROUTE,
  PRIVATE_BALANCE_UNWRAP_TRACK_ROUTE,
} from '../../helpers/constants/routes';
import { useI18nContext } from '../../hooks/useI18nContext';
import { selectEvmAddress } from '../../selectors/accounts';
import {
  addTransaction,
  confidentialErc7984EthCall,
  confidentialErc7984GetBalanceHandle,
  findNetworkClientIdByChainId,
} from '../../store/actions';
import {
  confidentialRevealedRowKey,
  invalidateStaleRevealsAfterHandleRefetch,
} from '../../helpers/confidential-erc7984-revealed-storage';
import {
  savePrivateBalanceUnwrapFinalizeSession,
  txMetaBroadcastHash,
} from '../../helpers/private-balance-unwrap-session';
const PRIVATE_BALANCE_UNWRAP_UI_TEMPORARILY_DISABLED = false;

export type PrivateBalanceShieldLocationState = {
  chainIdHex: Hex;
  token: ConfidentialTokenDefinition;
  initialTab?: 0 | 1;
  returnTo?: string;
};

function schedulePostShieldHandleRefresh(
  evmAddress: string,
  chainIdHex: Hex,
  token: ConfidentialTokenDefinition,
) {
  const key = confidentialRevealedRowKey(
    evmAddress,
    chainIdHex,
    token.address,
  );
  const row = { key, chainIdHex, tokenAddress: token.address };
  const delays = [0, 2500, 8000, 20000, 45000];
  for (const ms of delays) {
    setTimeout(() => {
      void invalidateStaleRevealsAfterHandleRefetch(
        [row],
        confidentialErc7984GetBalanceHandle,
        evmAddress,
      );
    }, ms);
  }
}

export default function PrivateBalanceShieldPage() {
  const t = useI18nContext();
  const navigate = useNavigate();
  const location = useLocation();
  const evmAddress = useSelector(selectEvmAddress) as string | undefined;

  const state = location.state as PrivateBalanceShieldLocationState | null;
  const chainIdHex = state?.chainIdHex;
  const token = state?.token;
  const initialTab = state?.initialTab ?? 0;
  const returnTo = state?.returnTo ?? DEFAULT_ROUTE;

  const [wrapTab, setWrapTab] = useState<0 | 1>(
    PRIVATE_BALANCE_UNWRAP_UI_TEMPORARILY_DISABLED ? 0 : initialTab,
  );
  const [amountShield, setAmountShield] = useState('');
  const [amountUnwrap, setAmountUnwrap] = useState('');
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [allowanceError, setAllowanceError] = useState<string | null>(null);
  const [underlyingBalance, setUnderlyingBalance] = useState<bigint | null>(
    null,
  );
  /** On-chain `decimals()` of the underlying ERC-20 (may differ from registry / wrapper). */
  const [underlyingDecimals, setUnderlyingDecimals] = useState<number | null>(
    null,
  );
  const [underlyingBalanceError, setUnderlyingBalanceError] = useState<
    string | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusHint, setStatusHint] = useState<string | null>(null);
  const [postApprovePolling, setPostApprovePolling] = useState(false);

  const chainIdNumber = chainIdHex
    ? Number(hexToBigInt(chainIdHex))
    : NaN;
  const underlying = token?.underlyingAddress;
  const canWrap = Boolean(token && underlying);
  const publicTokenDecimals = token
    ? (underlyingDecimals ?? token.decimals)
    : 18;

  useEffect(() => {
    if (!token || !chainIdHex) {
      return;
    }
    setWrapTab(
      PRIVATE_BALANCE_UNWRAP_UI_TEMPORARILY_DISABLED ? 0 : initialTab,
    );
    setError(null);
    setAmountShield('');
    setAmountUnwrap('');
    setBusy(false);
    setStatusHint(null);
    setPostApprovePolling(false);
    setUnderlyingBalance(null);
    setUnderlyingDecimals(null);
    setUnderlyingBalanceError(null);
  }, [initialTab, chainIdHex, token?.address]);

  useEffect(() => {
    if (PRIVATE_BALANCE_UNWRAP_UI_TEMPORARILY_DISABLED && wrapTab === 1) {
      setWrapTab(0);
    }
  }, [wrapTab]);

  useEffect(() => {
    setStatusHint(null);
    setError(null);
    if (wrapTab === 1) {
      setAllowanceError(null);
      setAllowance(null);
    }
  }, [wrapTab]);

  const refreshUnderlyingBalance = useCallback(async () => {
    if (!evmAddress || !underlying || !chainIdHex || !token) {
      setUnderlyingBalance(null);
      setUnderlyingDecimals(null);
      return;
    }
    setUnderlyingBalanceError(null);
    try {
      const balanceData = encodeFunctionData({
        abi: ERC20_ALLOWANCE_APPROVE_ABI,
        functionName: 'balanceOf',
        args: [evmAddress as `0x${string}`],
      });
      const decimalsData = encodeFunctionData({
        abi: ERC20_ALLOWANCE_APPROVE_ABI,
        functionName: 'decimals',
        args: [],
      });
      const [balanceRaw, decimalsRaw] = await Promise.all([
        confidentialErc7984EthCall(chainIdHex, underlying, balanceData),
        confidentialErc7984EthCall(chainIdHex, underlying, decimalsData),
      ]);
      const value = decodeFunctionResult({
        abi: ERC20_ALLOWANCE_APPROVE_ABI,
        data: balanceRaw as Hex,
        functionName: 'balanceOf',
      }) as bigint;
      const d = Number(
        decodeFunctionResult({
          abi: ERC20_ALLOWANCE_APPROVE_ABI,
          data: decimalsRaw as Hex,
          functionName: 'decimals',
        }),
      );
      setUnderlyingBalance(value);
      if (Number.isFinite(d) && d >= 0 && d <= 255) {
        setUnderlyingDecimals(d);
      } else {
        setUnderlyingDecimals(null);
      }
    } catch (e) {
      setUnderlyingBalance(null);
      setUnderlyingDecimals(null);
      setUnderlyingBalanceError(
        e instanceof Error ? e.message : t('privateBalanceWrapAllowanceFailed'),
      );
    }
  }, [chainIdHex, evmAddress, t, underlying, token]);

  const refreshAllowance = useCallback(async () => {
    if (!evmAddress || !underlying || !canWrap || !token || !chainIdHex) {
      setAllowance(null);
      return;
    }
    setAllowanceError(null);
    try {
      const data = encodeFunctionData({
        abi: ERC20_ALLOWANCE_APPROVE_ABI,
        functionName: 'allowance',
        args: [
          evmAddress as `0x${string}`,
          token.address as `0x${string}`,
        ],
      });
      const raw = await confidentialErc7984EthCall(
        chainIdHex,
        underlying,
        data,
      );
      const value = decodeFunctionResult({
        abi: ERC20_ALLOWANCE_APPROVE_ABI,
        data: raw as Hex,
        functionName: 'allowance',
      }) as bigint;
      setAllowance(value);
    } catch (e) {
      setAllowance(null);
      setAllowanceError(
        e instanceof Error ? e.message : t('privateBalanceWrapAllowanceFailed'),
      );
    }
  }, [canWrap, chainIdHex, evmAddress, t, token, underlying]);

  useEffect(() => {
    if (wrapTab === 0 && canWrap && chainIdHex && evmAddress) {
      void refreshAllowance();
      void refreshUnderlyingBalance();
    }
  }, [
    canWrap,
    refreshAllowance,
    refreshUnderlyingBalance,
    wrapTab,
    chainIdHex,
    evmAddress,
  ]);

  useEffect(() => {
    if (!postApprovePolling || !underlying) {
      return undefined;
    }
    const id = setInterval(() => {
      void refreshAllowance();
    }, 2500);
    return () => clearInterval(id);
  }, [postApprovePolling, refreshAllowance, underlying]);

  const handleBack = useCallback(() => {
    navigate(returnTo);
  }, [navigate, returnTo]);

  const submitTxAndNavigate = useCallback(
    async (
      txParams: {
        from: Hex;
        to: Hex;
        data: Hex;
        value: Hex;
      },
      options?: {
        beforeNavigate?: (transactionMeta: TransactionMeta) => void;
        keepOpenForReturn?: boolean;
        /** After the user approves the tx in the review screen, navigate here. */
        goBackToOverride?: string;
      },
    ) => {
      if (!chainIdHex) {
        throw new Error('Missing chain');
      }
      const networkClientId = await findNetworkClientIdByChainId(chainIdHex);
      const transactionMeta = await addTransaction(
        { ...txParams, chainId: chainIdHex },
        {
          networkClientId,
          type: TransactionType.contractInteraction,
        },
      );
      log.debug('[PrivateBalanceShieldPage] after addTransaction', {
        id: transactionMeta.id,
        hash: transactionMeta.hash,
        status: transactionMeta.status,
      });
      options?.beforeNavigate?.(transactionMeta);
      const back =
        location.pathname +
        (location.search || '') +
        (location.hash || '');
      const goBackTo =
        options?.goBackToOverride ??
        (options?.keepOpenForReturn ? back : returnTo);
      navigate({
        pathname: `${CONFIRM_TRANSACTION_ROUTE}/${transactionMeta.id}`,
        search: new URLSearchParams({
          goBackTo,
        }).toString(),
      });
      return transactionMeta;
    },
    [chainIdHex, location.hash, location.pathname, location.search, navigate, returnTo],
  );

  const shieldHuman = amountShield.trim();
  let shieldWei: bigint | null = null;
  try {
    if (shieldHuman && token && Number(shieldHuman) > 0) {
      shieldWei = parseUnits(shieldHuman, publicTokenDecimals);
    }
  } catch {
    shieldWei = null;
  }

  useEffect(() => {
    if (
      !postApprovePolling ||
      shieldWei === null ||
      allowance === null ||
      allowance < shieldWei
    ) {
      return;
    }
    setPostApprovePolling(false);
    setBusy(false);
    setStatusHint(t('privateBalanceWrapApproveDoneHint'));
  }, [postApprovePolling, shieldWei, allowance, t]);

  const onApprove = useCallback(async () => {
    if (!evmAddress || !underlying || !token || !chainIdHex) {
      return;
    }
    const human = amountShield.trim();
    if (!human || Number(human) <= 0) {
      setError(t('privateBalanceWrapInvalidAmount'));
      return;
    }
    let amountWei: bigint;
    try {
      amountWei = parseUnits(human, publicTokenDecimals);
    } catch {
      setError(t('privateBalanceWrapInvalidAmount'));
      return;
    }
    setBusy(true);
    setError(null);
    setStatusHint(null);
    try {
      const data = encodeFunctionData({
        abi: ERC20_ALLOWANCE_APPROVE_ABI,
        functionName: 'approve',
        args: [token.address as `0x${string}`, maxUint256],
      });
      await submitTxAndNavigate(
        {
          from: evmAddress as Hex,
          to: underlying as Hex,
          data: data as Hex,
          value: '0x0' as Hex,
        },
        {
          keepOpenForReturn: true,
          beforeNavigate: () => {
            setPostApprovePolling(true);
            setBusy(false);
            setStatusHint(t('privateBalanceWrapConfirmInMetaMask'));
          },
        },
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t('privateBalanceWrapApproveFailed'),
      );
      setPostApprovePolling(false);
      setBusy(false);
    }
  }, [
    amountShield,
    chainIdHex,
    evmAddress,
    submitTxAndNavigate,
    t,
    token,
    underlying,
    publicTokenDecimals,
  ]);

  const onShield = useCallback(async () => {
    if (!evmAddress || !underlying || !token || !chainIdHex) {
      return;
    }
    const human = amountShield.trim();
    if (!human || Number(human) <= 0) {
      setError(t('privateBalanceWrapInvalidAmount'));
      return;
    }
    let amountWei: bigint;
    try {
      amountWei = parseUnits(human, publicTokenDecimals);
    } catch {
      setError(t('privateBalanceWrapInvalidAmount'));
      return;
    }
    if (allowance === null) {
      setError(t('privateBalanceWrapCheckAllowance'));
      return;
    }
    if (allowance < amountWei) {
      setError(t('privateBalanceWrapNeedApprove'));
      return;
    }
    setBusy(true);
    setError(null);
    setStatusHint(null);
    try {
      const data = encodeFunctionData({
        abi: WRAP_ABI,
        functionName: 'wrap',
        args: [evmAddress as `0x${string}`, amountWei],
      });
      await submitTxAndNavigate(
        {
          from: evmAddress as Hex,
          to: token.address as Hex,
          data: data as Hex,
          value: '0x0' as Hex,
        },
        {
          keepOpenForReturn: true,
          beforeNavigate: () => {
            schedulePostShieldHandleRefresh(evmAddress, chainIdHex, token);
            setBusy(false);
            setStatusHint(t('privateBalanceWrapConfirmInMetaMask'));
          },
        },
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t('privateBalanceWrapShieldFailed'),
      );
      setBusy(false);
    }
  }, [
    allowance,
    amountShield,
    chainIdHex,
    evmAddress,
    submitTxAndNavigate,
    t,
    token,
    underlying,
    publicTokenDecimals,
  ]);

  const onUnwrapAmount = useCallback(async () => {
    if (
      PRIVATE_BALANCE_UNWRAP_UI_TEMPORARILY_DISABLED ||
      !evmAddress ||
      !token ||
      !chainIdHex ||
      Number.isNaN(chainIdNumber)
    ) {
      return;
    }
    const human = amountUnwrap.trim();
    if (!human || Number(human) <= 0) {
      setError(t('privateBalanceWrapInvalidAmount'));
      return;
    }
    setBusy(true);
    setError(null);
    setStatusHint(t('privateBalanceWrapUnwrapping'));
    try {
      const encDecimals = relayerEncryptDecimalsForToken(
        token.decimals,
        chainIdNumber,
      );
      const { handle, inputProof } = await relayerEncryptAmountForChain(
        {
          contractAddress: token.address,
          userAddress: evmAddress,
          amount: human,
          decimals: encDecimals,
        },
        chainIdNumber,
      );
      const data = encodeFunctionData({
        abi: UNWRAP_ABI,
        functionName: 'unwrap',
        args: [
          evmAddress as `0x${string}`,
          evmAddress as `0x${string}`,
          handle as `0x${string}`,
          inputProof as `0x${string}`,
        ],
      });
      await submitTxAndNavigate(
        {
          from: evmAddress as Hex,
          to: token.address as Hex,
          data: data as Hex,
          value: '0x0' as Hex,
        },
        {
          goBackToOverride: PRIVATE_BALANCE_UNWRAP_TRACK_ROUTE,
          beforeNavigate: (txMeta) => {
            const unwrapTxHash = txMetaBroadcastHash(txMeta) ?? undefined;
            savePrivateBalanceUnwrapFinalizeSession({
              unwrapTxMetaId: txMeta.id,
              unwrapTxHash,
              unwrapTxNonce: txMeta.txParams?.nonce,
              chainIdHex,
              tokenAddress: token.address,
              evmAddress,
            });
            setBusy(false);
            setStatusHint(null);
          },
        },
      );
    } catch (e) {
      setStatusHint(null);
      setError(
        e instanceof Error ? e.message : t('privateBalanceWrapUnwrapFailed'),
      );
      setBusy(false);
    }
  }, [
    amountUnwrap,
    chainIdHex,
    chainIdNumber,
    evmAddress,
    submitTxAndNavigate,
    t,
    token,
  ]);

  const needsApprove =
    shieldWei !== null &&
    allowance !== null &&
    allowance < shieldWei;

  if (!evmAddress || !chainIdHex || !token) {
    return <Navigate to={DEFAULT_ROUTE} replace />;
  }

  const publicSymbol = getUnderlyingPublicDisplaySymbol(token);
  const underlyingFormatted =
    underlyingBalance !== null && token
      ? formatUnits(underlyingBalance, publicTokenDecimals)
      : null;

  return (
    <Box
      alignItems={AlignItems.center}
      backgroundColor={BackgroundColor.backgroundDefault}
      className="redesigned__send__container"
      display={Display.Flex}
      flexDirection={FlexDirection.Column}
      height={BlockSize.Full}
      justifyContent={JustifyContent.center}
      style={{ flex: '1 0 auto', minHeight: 0 }}
      width={BlockSize.Full}
    >
      <Box
        backgroundColor={BackgroundColor.backgroundSection}
        className="redesigned__send__wrapper"
        display={Display.Flex}
        height={BlockSize.Full}
        justifyContent={JustifyContent.center}
        width={BlockSize.Full}
        borderRadius={BorderRadius.LG}
      >
        <Box
          className="redesigned__send__content"
          display={Display.Flex}
          flexDirection={FlexDirection.Column}
          height={BlockSize.Full}
          width={BlockSize.Full}
        >
          <Box
            alignItems={AlignItems.center}
            className="send-header__wrapper redesigned__send__sticky-header"
            display={Display.Flex}
            justifyContent={JustifyContent.center}
          >
            <ButtonIcon
              ariaLabel={t('back')}
              className="send-header__previous-btn"
              iconName={IconName.ArrowLeft}
              onClick={handleBack}
              size={ButtonIconSize.Sm}
            />
            <Text variant={TextVariant.headingSm}>
              {t('privateBalanceWrapTitle', [token.symbol])}
            </Text>
          </Box>
          <ScrollContainer className="redesigned__send__content-wrapper">
            <Box marginTop={2} marginBottom={2} padding={4}>
              <Box display={Display.Flex} gap={2} marginBottom={3}>
                {wrapTab === 0 ? (
                  <ButtonPrimary onClick={() => setWrapTab(0)} block>
                    {t('privateBalanceWrapTabShield')}
                  </ButtonPrimary>
                ) : (
                  <ButtonSecondary onClick={() => setWrapTab(0)} block>
                    {t('privateBalanceWrapTabShield')}
                  </ButtonSecondary>
                )}
                {wrapTab === 1 ? (
                  <ButtonPrimary
                    disabled={PRIVATE_BALANCE_UNWRAP_UI_TEMPORARILY_DISABLED}
                    onClick={() => {
                      if (!PRIVATE_BALANCE_UNWRAP_UI_TEMPORARILY_DISABLED) {
                        setWrapTab(1);
                      }
                    }}
                    block
                  >
                    {PRIVATE_BALANCE_UNWRAP_UI_TEMPORARILY_DISABLED
                      ? t('privateBalanceWrapUnwrapComingSoonShort')
                      : t('privateBalanceWrapTabUnwrap')}
                  </ButtonPrimary>
                ) : (
                  <ButtonSecondary
                    disabled={PRIVATE_BALANCE_UNWRAP_UI_TEMPORARILY_DISABLED}
                    onClick={() => {
                      if (!PRIVATE_BALANCE_UNWRAP_UI_TEMPORARILY_DISABLED) {
                        setWrapTab(1);
                      }
                    }}
                    block
                  >
                    {PRIVATE_BALANCE_UNWRAP_UI_TEMPORARILY_DISABLED
                      ? t('privateBalanceWrapUnwrapComingSoonShort')
                      : t('privateBalanceWrapTabUnwrap')}
                  </ButtonSecondary>
                )}
              </Box>

              {wrapTab === 0 ? (
                <>
                  {!canWrap ? (
                    <Text>{t('privateBalanceWrapNoUnderlying')}</Text>
                  ) : (
                    <>
                      {underlyingFormatted !== null ? (
                        <Text marginBottom={2} color="text-muted">
                          {t('privateBalanceWrapAvailablePublic', [
                            underlyingFormatted,
                            publicSymbol,
                          ])}
                        </Text>
                      ) : null}
                      {underlyingBalanceError ? (
                        <Box marginBottom={2}>
                          <Text marginBottom={2}>{underlyingBalanceError}</Text>
                          <ButtonSecondary
                            onClick={() => void refreshUnderlyingBalance()}
                            block
                          >
                            {t('privateBalanceWrapRetryAllowance')}
                          </ButtonSecondary>
                        </Box>
                      ) : null}
                      <FormTextField
                        marginBottom={2}
                        label={t('privateBalanceWrapAmount')}
                        value={amountShield}
                        onChange={(e) => setAmountShield(e.target.value)}
                      />
                      {allowanceError ? (
                        <Box marginBottom={2}>
                          <Text marginBottom={2}>{allowanceError}</Text>
                          <ButtonSecondary
                            onClick={() => void refreshAllowance()}
                            block
                          >
                            {t('privateBalanceWrapRetryAllowance')}
                          </ButtonSecondary>
                        </Box>
                      ) : null}
                    </>
                  )}
                </>
              ) : (
                <FormTextField
                  marginBottom={2}
                  label={t('privateBalanceWrapAmount')}
                  value={amountUnwrap}
                  onChange={(e) => setAmountUnwrap(e.target.value)}
                  disabled={PRIVATE_BALANCE_UNWRAP_UI_TEMPORARILY_DISABLED}
                />
              )}

              {statusHint ? (
                <Text marginTop={2} color="text-muted">
                  {statusHint}
                </Text>
              ) : null}
              {error ? (
                <Text marginTop={2} color="error-default">
                  {error}
                </Text>
              ) : null}

              <Box marginTop={4}>
                <ButtonSecondary onClick={handleBack} block marginBottom={2}>
                  {t('cancel')}
                </ButtonSecondary>
                {wrapTab === 0 && canWrap ? (
                  needsApprove ? (
                    <ButtonPrimary onClick={onApprove} disabled={busy} block>
                      {t('privateBalanceWrapApprove')}
                    </ButtonPrimary>
                  ) : (
                    <ButtonPrimary onClick={onShield} disabled={busy} block>
                      {t('privateBalanceWrapShield')}
                    </ButtonPrimary>
                  )
                ) : null}
                {wrapTab === 1 ? (
                  <ButtonPrimary
                    onClick={onUnwrapAmount}
                    disabled={
                      PRIVATE_BALANCE_UNWRAP_UI_TEMPORARILY_DISABLED || busy
                    }
                    block
                  >
                    {PRIVATE_BALANCE_UNWRAP_UI_TEMPORARILY_DISABLED
                      ? t('privateBalanceWrapUnwrapComingSoonShort')
                      : busy
                        ? t('privateBalanceWrapUnwrapping')
                        : t('privateBalanceWrapUnwrap')}
                  </ButtonPrimary>
                ) : null}
              </Box>
            </Box>
          </ScrollContainer>
        </Box>
      </Box>
    </Box>
  );
}
