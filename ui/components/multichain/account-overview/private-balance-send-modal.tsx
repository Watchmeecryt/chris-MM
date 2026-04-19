import React, { useCallback, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Hex } from '@metamask/utils';
import { hexToBigInt } from '@metamask/utils';
import { encodeFunctionData, getAddress } from 'viem';
import { TransactionType } from '@metamask/transaction-controller';
import {
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
import { CONFIDENTIAL_TRANSFER_ABI } from '../../../../shared/lib/confidential-erc7984/abi';
import type { ConfidentialTokenDefinition } from '../../../../shared/lib/confidential-erc7984/registry';
import {
  relayerEncryptAmountForChain,
  relayerEncryptDecimalsForToken,
} from '../../../../shared/lib/confidential-erc7984/relayer';
import { CONFIRM_TRANSACTION_ROUTE } from '../../../helpers/constants/routes';
import { useI18nContext } from '../../../hooks/useI18nContext';
import {
  addTransaction,
  findNetworkClientIdByChainId,
} from '../../../store/actions';

export type PrivateBalanceSendModalProps = {
  isOpen: boolean;
  onClose: () => void;
  evmAddress: string;
  chainIdHex: Hex;
  token: ConfidentialTokenDefinition;
};

export function PrivateBalanceSendModal({
  isOpen,
  onClose,
  evmAddress,
  chainIdHex,
  token,
}: PrivateBalanceSendModalProps) {
  const t = useI18nContext();
  const navigate = useNavigate();
  const location = useLocation();
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chainIdNumber = Number(hexToBigInt(chainIdHex));

  const reset = useCallback(() => {
    setRecipient('');
    setAmount('');
    setError(null);
    setBusy(false);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  const onSubmit = useCallback(async () => {
    setError(null);
    const human = amount.trim();
    if (!human || Number(human) <= 0) {
      setError(t('privateBalanceSendInvalidAmount'));
      return;
    }
    let to: Hex;
    try {
      to = getAddress(recipient.trim()) as Hex;
    } catch {
      setError(t('privateBalanceSendInvalidRecipient'));
      return;
    }

    setBusy(true);
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
        abi: CONFIDENTIAL_TRANSFER_ABI,
        functionName: 'confidentialTransfer',
        args: [to, handle as `0x${string}`, inputProof as `0x${string}`],
      });

      const networkClientId = await findNetworkClientIdByChainId(chainIdHex);
      const txParams = {
        from: evmAddress as Hex,
        to: token.address as Hex,
        value: '0x0' as Hex,
        data: data as Hex,
        chainId: chainIdHex,
      };

      const transactionMeta = await addTransaction(txParams, {
        networkClientId,
        type: TransactionType.contractInteraction,
      });

      handleClose();
      navigate({
        pathname: `${CONFIRM_TRANSACTION_ROUTE}/${transactionMeta.id}`,
        search: new URLSearchParams({
          goBackTo: location.pathname + location.search,
        }).toString(),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('privateBalanceSendFailed'));
      setBusy(false);
    }
  }, [
    amount,
    chainIdHex,
    chainIdNumber,
    evmAddress,
    handleClose,
    location.pathname,
    location.search,
    navigate,
    recipient,
    t,
    token.address,
    token.decimals,
  ]);

  return (
    <Modal isOpen={isOpen} onClose={handleClose}>
      <ModalOverlay />
      <ModalContent>
        <ModalHeader onClose={handleClose}>
          {t('privateBalanceSendTitle', [token.symbol])}
        </ModalHeader>
        <ModalBody marginTop={2} marginBottom={2}>
          <Text marginBottom={2}>{t('privateBalanceSendDescription')}</Text>
          <FormTextField
            marginBottom={2}
            label={t('privateBalanceSendRecipient')}
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="0x…"
          />
          <FormTextField
            marginBottom={2}
            label={t('privateBalanceSendAmount')}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="1.0"
          />
          {error ? (
            <Text color="error-default" marginBottom={2}>
              {error}
            </Text>
          ) : null}
        </ModalBody>
        <ModalFooter>
          <ButtonSecondary onClick={handleClose} block marginBottom={2}>
            {t('cancel')}
          </ButtonSecondary>
          <ButtonPrimary onClick={onSubmit} disabled={busy} block>
            {busy ? t('privateBalanceSendSubmitting') : t('privateBalanceSendSubmit')}
          </ButtonPrimary>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
