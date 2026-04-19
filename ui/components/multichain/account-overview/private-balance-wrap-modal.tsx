import React, { useCallback, useEffect, useState } from 'react';
import log from 'loglevel';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Hex } from '@metamask/utils';
import { hexToBigInt } from '@metamask/utils';
import {
  decodeFunctionResult,
  encodeFunctionData,
  maxUint256,
  parseUnits,
} from 'viem';
import {
  TransactionType,
  type TransactionMeta,
} from '@metamask/transaction-controller';
import {
  Box,
  ButtonPrimary,
  ButtonSecondary,
  FormTextField,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Text,
} from '../../component-library';
import {
  ERC20_ALLOWANCE_APPROVE_ABI,
  UNWRAP_ABI,
  WRAP_ABI,
} from '../../../../shared/lib/confidential-erc7984/abi';
import type { ConfidentialTokenDefinition } from '../../../../shared/lib/confidential-erc7984/registry';
import {
  relayerEncryptAmountForChain,
  relayerEncryptDecimalsForToken,
} from '../../../../shared/lib/confidential-erc7984/relayer';
import { CONFIRM_TRANSACTION_ROUTE } from '../../../helpers/constants/routes';
import { useI18nContext } from '../../../hooks/useI18nContext';
import {
  addTransaction,
  confidentialErc7984EthCall,
  findNetworkClientIdByChainId,
} from '../../../store/actions';
import {
  savePrivateBalanceUnwrapFinalizeSession,
  txMetaBroadcastHash,
} from '../../../helpers/private-balance-unwrap-session';

/** Unwrap pipeline stays in code; UI is disabled until Activity / tx-meta UX is reliable. */
const PRIVATE_BALANCE_UNWRAP_UI_TEMPORARILY_DISABLED = true;

export type PrivateBalanceWrapModalProps = {
  isOpen: boolean;
  onClose: () => void;
  evmAddress: string;
  chainIdHex: Hex;
  token: ConfidentialTokenDefinition;
  /** 0 = shield (wrap), 1 = unshield (unwrap) */
  initialTab: 0 | 1;
  /**
   * When the Shield tab is active, mirror `statusHint` to the Private balance list banner
   * so a stale unwrap-finalize message is not shown during wrap/approve.
   */
  onShieldTabBannerChange?: (hint: string | null) => void;
  /** Called after a shield (wrap) tx is queued so the parent can refresh on-chain handles. */
  onShieldTransactionQueued?: () => void;
};

export function PrivateBalanceWrapModal({
  isOpen,
  onClose,
  evmAddress,
  chainIdHex,
  token,
  initialTab,
  onShieldTabBannerChange,
  onShieldTransactionQueued,
}: PrivateBalanceWrapModalProps) {
  const t = useI18nContext();
  const navigate = useNavigate();
  const location = useLocation();
  const [wrapTab, setWrapTab] = useState<0 | 1>(initialTab);
  const [amountShield, setAmountShield] = useState('');
  const [amountUnwrap, setAmountUnwrap] = useState('');
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [allowanceError, setAllowanceError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusHint, setStatusHint] = useState<string | null>(null);
  const [postApprovePolling, setPostApprovePolling] = useState(false);

  const chainIdNumber = Number(hexToBigInt(chainIdHex));
  const underlying = token.underlyingAddress;
  const canWrap = Boolean(underlying);

  useEffect(() => {
    if (isOpen) {
      setWrapTab(
        PRIVATE_BALANCE_UNWRAP_UI_TEMPORARILY_DISABLED ? 0 : initialTab,
      );
      setError(null);
      setAmountShield('');
      setAmountUnwrap('');
      setBusy(false);
      setStatusHint(null);
      setPostApprovePolling(false);
    }
  }, [initialTab, isOpen]);

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

  useEffect(() => {
    if (!isOpen) {
      onShieldTabBannerChange?.(null);
      return;
    }
    if (wrapTab === 0) {
      onShieldTabBannerChange?.(statusHint);
    } else {
      onShieldTabBannerChange?.(null);
    }
  }, [isOpen, onShieldTabBannerChange, statusHint, wrapTab]);

  const refreshAllowance = useCallback(async () => {
    if (!underlying || !canWrap) {
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
  }, [canWrap, chainIdHex, evmAddress, t, token.address, underlying]);

  useEffect(() => {
    if (isOpen && wrapTab === 0 && canWrap) {
      refreshAllowance();
    }
  }, [canWrap, isOpen, refreshAllowance, wrapTab]);

  useEffect(() => {
    if (!isOpen || !postApprovePolling || !underlying) {
      return undefined;
    }
    const id = setInterval(() => {
      void refreshAllowance();
    }, 2500);
    return () => clearInterval(id);
  }, [isOpen, postApprovePolling, refreshAllowance, underlying]);

  const handleClose = useCallback(() => {
    onShieldTabBannerChange?.(null);
    setError(null);
    setStatusHint(null);
    setPostApprovePolling(false);
    onClose();
  }, [onClose, onShieldTabBannerChange]);

  /**
   * Queue tx → optional hooks → optionally close modal → confirm route.
   * Approve/shield pass `keepModalOpenOnConfirm` so the user returns to this modal after signing and can wrap immediately.
   */
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
        /** When true, do not call onClose — modal stays open under the confirm screen until user navigates back. */
        keepModalOpenOnConfirm?: boolean;
      },
    ) => {
      const networkClientId = await findNetworkClientIdByChainId(chainIdHex);
      const transactionMeta = await addTransaction(
        { ...txParams, chainId: chainIdHex },
        {
          networkClientId,
          type: TransactionType.contractInteraction,
        },
      );
      log.debug('[PrivateBalanceWrapModal] after addTransaction', {
        id: transactionMeta.id,
        hash: transactionMeta.hash,
        status: transactionMeta.status,
      });
      options?.beforeNavigate?.(transactionMeta);
      if (!options?.keepModalOpenOnConfirm) {
        handleClose();
      }
      navigate({
        pathname: `${CONFIRM_TRANSACTION_ROUTE}/${transactionMeta.id}`,
        search: new URLSearchParams({
          goBackTo: location.pathname + location.search,
        }).toString(),
      });
      return transactionMeta;
    },
    [chainIdHex, handleClose, location.pathname, location.search, navigate],
  );

  const shieldHuman = amountShield.trim();
  let shieldWei: bigint | null = null;
  try {
    if (shieldHuman && Number(shieldHuman) > 0) {
      shieldWei = parseUnits(shieldHuman, token.decimals);
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
    if (!underlying) {
      return;
    }
    const human = amountShield.trim();
    if (!human || Number(human) <= 0) {
      setError(t('privateBalanceWrapInvalidAmount'));
      return;
    }
    let amountWei: bigint;
    try {
      amountWei = parseUnits(human, token.decimals);
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
          keepModalOpenOnConfirm: true,
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
    evmAddress,
    submitTxAndNavigate,
    t,
    token.address,
    token.decimals,
    underlying,
  ]);

  const onShield = useCallback(async () => {
    if (!underlying) {
      return;
    }
    const human = amountShield.trim();
    if (!human || Number(human) <= 0) {
      setError(t('privateBalanceWrapInvalidAmount'));
      return;
    }
    let amountWei: bigint;
    try {
      amountWei = parseUnits(human, token.decimals);
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
          keepModalOpenOnConfirm: true,
          beforeNavigate: () => {
            onShieldTransactionQueued?.();
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
    evmAddress,
    onShieldTransactionQueued,
    submitTxAndNavigate,
    t,
    token.address,
    token.decimals,
    underlying,
  ]);

  const onUnwrapAmount = useCallback(async () => {
    if (PRIVATE_BALANCE_UNWRAP_UI_TEMPORARILY_DISABLED) {
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
    token.address,
    token.decimals,
  ]);

  const needsApprove =
    shieldWei !== null &&
    allowance !== null &&
    allowance < shieldWei;

  return (
    <Modal isOpen={isOpen} onClose={handleClose}>
      <ModalOverlay />
      <ModalContent>
        <ModalHeader onClose={handleClose}>
          {t('privateBalanceWrapTitle', [token.symbol])}
        </ModalHeader>
        <ModalBody marginTop={2} marginBottom={2}>
          <Box display="flex" gap={2} marginBottom={3}>
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
                  <Text marginBottom={2}>{t('privateBalanceWrapShieldHelp')}</Text>
                  <FormTextField
                    marginBottom={2}
                    label={t('privateBalanceWrapAmount')}
                    value={amountShield}
                    onChange={(e) => setAmountShield(e.target.value)}
                  />
                  {allowanceError ? (
                    <Box marginBottom={2}>
                      <Text marginBottom={2}>{allowanceError}</Text>
                      <ButtonSecondary onClick={() => void refreshAllowance()} block>
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
        </ModalBody>
        <ModalFooter>
          <ButtonSecondary onClick={handleClose} block marginBottom={2}>
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
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
