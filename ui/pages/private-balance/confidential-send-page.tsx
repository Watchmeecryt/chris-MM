import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import browser from 'webextension-polyfill';
import type { Hex } from '@metamask/utils';
import { hexToBigInt } from '@metamask/utils';
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
} from 'viem';
import { TransactionType } from '@metamask/transaction-controller';
import { AssetType } from '../../../shared/constants/transaction';
import type { TokenFiatDisplayInfo } from '../../components/app/assets/types';
import { getCurrentCurrency } from '../../ducks/metamask/metamask';
import AssetChart from '../asset/components/chart/asset-chart';
import { Erc7984WrapperTokenDetails } from '../asset/components/erc7984-wrapper-token-details';
import { useCurrentPrice } from '../asset/hooks/useCurrentPrice';
import type { Asset as OverviewAsset } from '../asset/types/asset';
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
  Modal,
  ModalBody,
  ModalContent,
  ModalContentSize,
  ModalHeader,
  ModalOverlay,
  Text,
  TextField,
  TextFieldSize,
} from '../../components/component-library';
import { ScrollContainer } from '../../contexts/scroll-container';
import {
  CONFIDENTIAL_TRANSFER_ABI,
  ERC20_ALLOWANCE_APPROVE_ABI,
} from '../../../shared/lib/confidential-erc7984/abi';
import {
  canonicalStringify,
  toTypedDataV4Params,
} from '../../../shared/lib/confidential-erc7984/eip712';
import {
  cleartextFromUserDecryptResult,
  relayerUserDecryptCompleteForChain,
  relayerUserDecryptPrepareForChain,
} from '../../../shared/lib/confidential-erc7984/relayer';
import {
  CONFIDENTIAL_ZERO_HANDLE,
  type ConfidentialTokenDefinition,
} from '../../../shared/lib/confidential-erc7984/registry';
import {
  relayerEncryptAmountForChain,
  relayerEncryptDecimalsForToken,
} from '../../../shared/lib/confidential-erc7984/relayer';
import {
  addPendingDecryptRow,
  CONFIDENTIAL_BALANCE_MASKED_KEY,
  CONFIDENTIAL_PENDING_DECRYPT_AT_KEY,
  CONFIDENTIAL_PENDING_DECRYPT_KEY,
  CONFIDENTIAL_REVEALED_BALANCES_KEY,
  confidentialRevealedRowKey,
  loadBalanceMaskedMap,
  loadConfidentialRevealedBalances,
  loadPendingDecryptRows,
  pruneStalePendingDecryptRows,
  removePendingDecryptRow,
  saveConfidentialRevealedDisplay,
  setBalanceMasked,
} from '../../helpers/confidential-erc7984-revealed-storage';
import {
  CONFIRM_TRANSACTION_ROUTE,
  DEFAULT_ROUTE,
} from '../../helpers/constants/routes';
import { stringifyBalance } from '../../hooks/useTokenBalances';
import { useI18nContext } from '../../hooks/useI18nContext';
import { selectEvmAddress } from '../../selectors/accounts';
import { getTokenList, selectERC20TokensByChain } from '../../selectors';
import {
  getImageForChainId,
  getMultichainNetworkConfigurationsByChainId,
} from '../../selectors/multichain';
import { getCurrentChainId } from '../../../shared/lib/selectors/networks';
import {
  addTransaction,
  confidentialErc7984EthCall,
  confidentialErc7984GetBalanceHandle,
  confidentialErc7984SignTypedDataV4,
  findNetworkClientIdByChainId,
} from '../../store/actions';
import { SendHero } from '../confirmations/components/UI/send-hero/send-hero';
import { RecipientList } from '../confirmations/components/send/recipient-list/recipient-list';
import {
  AssetStandard,
  type Asset,
} from '../confirmations/types/send';
import { usePrivateConfidentialSendRecipients } from './use-private-confidential-send-recipients';

export type PrivateBalanceConfidentialSendLocationState = {
  chainIdHex: Hex;
  token: ConfidentialTokenDefinition;
  returnTo?: string;
};

/** Inert placeholder so `useCurrentPrice` can run before we know navigation state. */
const PRICE_HOOK_FALLBACK_ASSET: OverviewAsset = {
  type: AssetType.token,
  address: '0x0000000000000000000000000000000000000000',
  chainId: '0x1',
  symbol: 'ETH',
  decimals: 18,
  image: '',
};

export default function PrivateBalanceConfidentialSendPage() {
  const t = useI18nContext();
  const navigate = useNavigate();
  const location = useLocation();
  const evmAddress = useSelector(selectEvmAddress) as string | undefined;

  const state = location.state as PrivateBalanceConfidentialSendLocationState | null;
  const chainIdHex = state?.chainIdHex;
  const token = state?.token;
  const returnTo = state?.returnTo ?? DEFAULT_ROUTE;

  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recipientModalOpen, setRecipientModalOpen] = useState(false);
  /** Underlying ERC-20 `decimals()` only — for TVS USD line (no public balance on send). */
  const [underlyingDecimalsOnly, setUnderlyingDecimalsOnly] = useState<
    number | null
  >(null);
  const [confidentialBalanceDisplay, setConfidentialBalanceDisplay] = useState<
    string | null
  >(null);
  const [confidentialDecryptPending, setConfidentialDecryptPending] =
    useState(false);
  const [confidentialDecryptError, setConfidentialDecryptError] = useState<
    string | null
  >(null);
  const [confidentialBalanceMasked, setConfidentialBalanceMasked] =
    useState(false);
  const recipientInputRef = useRef<HTMLInputElement>(null);
  const erc20TokensByChain = useSelector(selectERC20TokensByChain);
  const tokenList = useSelector(getTokenList);
  const currentChainId = useSelector(getCurrentChainId);
  const currency = useSelector(getCurrentCurrency);
  const networkConfigurationsByChainId = useSelector(
    getMultichainNetworkConfigurationsByChainId,
  );
  const pickerRecipients = usePrivateConfidentialSendRecipients(chainIdHex);

  const underlyingIconUrl = useMemo(() => {
    if (!token?.underlyingAddress || !chainIdHex) {
      return '';
    }
    const u = token.underlyingAddress.toLowerCase();
    let image = erc20TokensByChain?.[chainIdHex]?.data?.[u]?.iconUrl;
    if (!image && chainIdHex === currentChainId) {
      image = (tokenList as Record<string, { iconUrl?: string }>)?.[
        u
      ]?.iconUrl;
    }
    if (!image) {
      image = Object.values(
        (tokenList ?? {}) as Record<
          string,
          { address?: string; iconUrl?: string }
        >,
      ).find(
        (entry) =>
          typeof entry?.address === 'string' &&
          entry.address.toLowerCase() === u,
      )?.iconUrl;
    }
    return image ?? '';
  }, [chainIdHex, currentChainId, erc20TokensByChain, token, tokenList]);

  const underlyingPriceAsset = useMemo((): OverviewAsset | null => {
    if (!token || !chainIdHex || !token.underlyingAddress) {
      return null;
    }
    const u = token.underlyingAddress.toLowerCase();
    const aggregators = erc20TokensByChain?.[chainIdHex]?.data?.[u]?.aggregators;
    return {
      type: AssetType.token,
      address: token.underlyingAddress,
      chainId: chainIdHex,
      /** Registry confidential ticker in UI; price still resolved by underlying `address`. */
      symbol: token.symbol,
      decimals: token.decimals,
      image: underlyingIconUrl,
      aggregators,
    };
  }, [chainIdHex, erc20TokensByChain, token, underlyingIconUrl]);

  const { currentPrice } = useCurrentPrice(
    underlyingPriceAsset ?? PRICE_HOOK_FALLBACK_ASSET,
  );

  const chartDisplayAsset = useMemo((): TokenFiatDisplayInfo | undefined => {
    if (!underlyingPriceAsset) {
      return undefined;
    }
    const img = underlyingIconUrl || '';
    return {
      address: underlyingPriceAsset.address as Hex,
      chainId: underlyingPriceAsset.chainId,
      symbol: underlyingPriceAsset.symbol,
      decimals: underlyingPriceAsset.decimals,
      image: img,
      title: underlyingPriceAsset.symbol,
      tokenImage: img,
      tokenChainImage: getImageForChainId(underlyingPriceAsset.chainId),
      string: '0',
      secondary: 0,
      balance: '0',
      tokenFiatAmount: null,
      isNative: false,
    };
  }, [underlyingPriceAsset, underlyingIconUrl]);

  const sendHeroAsset = useMemo((): Asset | undefined => {
    if (!token || !chainIdHex) {
      return undefined;
    }
    return {
      address: token.address,
      symbol: token.symbol,
      decimals: token.decimals,
      chainId: chainIdHex,
      image: underlyingIconUrl || undefined,
      standard: AssetStandard.ERC20,
      networkName: networkConfigurationsByChainId[chainIdHex]?.name,
      networkImage: getImageForChainId(chainIdHex),
    };
  }, [
    chainIdHex,
    networkConfigurationsByChainId,
    token,
    underlyingIconUrl,
  ]);

  useEffect(() => {
    if (!token?.underlyingAddress || !chainIdHex) {
      setUnderlyingDecimalsOnly(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const decimalsData = encodeFunctionData({
          abi: ERC20_ALLOWANCE_APPROVE_ABI,
          functionName: 'decimals',
          args: [],
        });
        const decimalsRaw = await confidentialErc7984EthCall(
          chainIdHex,
          token.underlyingAddress as string,
          decimalsData,
        );
        const d = Number(
          decodeFunctionResult({
            abi: ERC20_ALLOWANCE_APPROVE_ABI,
            data: decimalsRaw as Hex,
            functionName: 'decimals',
          }),
        );
        if (!cancelled) {
          if (Number.isFinite(d) && d >= 0 && d <= 255) {
            setUnderlyingDecimalsOnly(d);
          } else {
            setUnderlyingDecimalsOnly(null);
          }
        }
      } catch {
        if (!cancelled) {
          setUnderlyingDecimalsOnly(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chainIdHex, token?.underlyingAddress]);

  const confidentialRowKey = useMemo(
    () =>
      evmAddress && chainIdHex && token
        ? confidentialRevealedRowKey(evmAddress, chainIdHex, token.address)
        : '',
    [chainIdHex, evmAddress, token],
  );

  useEffect(() => {
    if (!confidentialRowKey) {
      return undefined;
    }
    let cancelled = false;

    const mergeFromStorage = async () => {
      await pruneStalePendingDecryptRows();
      const [revealed, pendingRows, maskedMap] = await Promise.all([
        loadConfidentialRevealedBalances(),
        loadPendingDecryptRows(),
        loadBalanceMaskedMap(),
      ]);
      if (cancelled) {
        return;
      }
      const display = revealed[confidentialRowKey] ?? null;
      const isPending = Boolean(pendingRows[confidentialRowKey]) && !display;
      setConfidentialBalanceDisplay(display);
      setConfidentialDecryptPending(isPending);
      setConfidentialBalanceMasked(Boolean(maskedMap[confidentialRowKey]));
      if (display) {
        setConfidentialDecryptError(null);
      }
    };

    void mergeFromStorage();

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
        !changes[CONFIDENTIAL_BALANCE_MASKED_KEY]
      ) {
        return;
      }
      void mergeFromStorage();
    };

    browser.storage.onChanged.addListener(onStorageChanged);
    return () => {
      cancelled = true;
      browser.storage.onChanged.removeListener(onStorageChanged);
    };
  }, [confidentialRowKey]);

  const chainIdNumber = chainIdHex
    ? Number(hexToBigInt(chainIdHex))
    : NaN;

  const handleBack = useCallback(() => {
    navigate(returnTo);
  }, [navigate, returnTo]);

  const closeRecipientModal = useCallback(() => {
    setRecipientModalOpen(false);
  }, []);

  const openRecipientModal = useCallback(() => {
    recipientInputRef.current?.blur();
    setRecipientModalOpen(true);
  }, []);

  const onRecipientPicked = useCallback((address: string) => {
    setRecipient(address);
    setRecipientModalOpen(false);
  }, []);

  const decryptConfidentialBalance = useCallback(async () => {
    if (
      !evmAddress ||
      !chainIdHex ||
      !token ||
      Number.isNaN(chainIdNumber) ||
      !confidentialRowKey
    ) {
      return;
    }
    setConfidentialDecryptError(null);
    await addPendingDecryptRow(confidentialRowKey);
    setConfidentialDecryptPending(true);
    try {
      const h = await confidentialErc7984GetBalanceHandle(
        chainIdHex,
        token.address,
        evmAddress as string,
      );
      if (
        !h ||
        h.toLowerCase() === CONFIDENTIAL_ZERO_HANDLE.toLowerCase()
      ) {
        setConfidentialDecryptError(t('privateBalanceDecryptAllNoBalances'));
        return;
      }
      const prepare = await relayerUserDecryptPrepareForChain(
        { handles: [h], contractAddresses: [token.address] },
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
      const amount = cleartextFromUserDecryptResult(result, h);
      const display = stringifyBalance(amount.toString(), token.decimals);
      await saveConfidentialRevealedDisplay(confidentialRowKey, display, h);
      setConfidentialBalanceDisplay(display);
      setConfidentialBalanceMasked(false);
    } catch (e) {
      const rawMsg = e instanceof Error ? e.message : String(e);
      const isGatewayNotReady =
        /not ready for decryption|gateway chain|503|response_timed_out/i.test(
          rawMsg,
        );
      setConfidentialDecryptError(
        isGatewayNotReady
          ? t('privateBalanceDecryptGatewayNotReady')
          : rawMsg || t('privateBalanceDecryptFailed'),
      );
    } finally {
      await removePendingDecryptRow(confidentialRowKey);
      setConfidentialDecryptPending(false);
    }
  }, [
    chainIdHex,
    chainIdNumber,
    confidentialRowKey,
    evmAddress,
    t,
    token,
  ]);

  const onConfidentialBalanceEyeClick = useCallback(async () => {
    if (
      !evmAddress ||
      !chainIdHex ||
      !token ||
      !confidentialRowKey ||
      confidentialDecryptPending
    ) {
      return;
    }
    if (!confidentialBalanceDisplay) {
      await decryptConfidentialBalance();
      return;
    }
    if (confidentialBalanceMasked) {
      await setBalanceMasked(confidentialRowKey, false);
      setConfidentialBalanceMasked(false);
      return;
    }
    await setBalanceMasked(confidentialRowKey, true);
    setConfidentialBalanceMasked(true);
  }, [
    chainIdHex,
    confidentialBalanceDisplay,
    confidentialBalanceMasked,
    confidentialDecryptPending,
    confidentialRowKey,
    decryptConfidentialBalance,
    evmAddress,
    token,
  ]);

  const onSubmit = useCallback(async () => {
    if (!evmAddress || !chainIdHex || !token || Number.isNaN(chainIdNumber)) {
      return;
    }
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

      navigate({
        pathname: `${CONFIRM_TRANSACTION_ROUTE}/${transactionMeta.id}`,
        search: new URLSearchParams({
          goBackTo: returnTo,
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
    navigate,
    recipient,
    returnTo,
    t,
    token,
  ]);

  if (!evmAddress || !chainIdHex || !token) {
    return <Navigate to={DEFAULT_ROUTE} replace />;
  }

  const tvsUnderlyingDecimals = underlyingDecimalsOnly ?? token.decimals;

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
              {t('privateBalanceSendTitle', [token.symbol])}
            </Text>
          </Box>
          <ScrollContainer className="redesigned__send__content-wrapper">
            <Box marginTop={2} marginBottom={2} padding={4}>
              {sendHeroAsset ? <SendHero asset={sendHeroAsset} /> : null}
              <Box marginTop={2}>
                <Erc7984WrapperTokenDetails
                  chainId={chainIdHex}
                  wrapperAddress={token.address}
                  decimals={token.decimals}
                  symbol={token.symbol}
                  underlyingDecimals={tvsUnderlyingDecimals}
                  underlyingFiatPerToken={currentPrice}
                  fiatCurrencyCode={currency}
                />
              </Box>
              {underlyingPriceAsset && chartDisplayAsset ? (
                <Box marginTop={4} marginBottom={2}>
                  <AssetChart
                    chainId={chainIdHex}
                    address={underlyingPriceAsset.address}
                    currentPrice={currentPrice}
                    currency={currency}
                    asset={chartDisplayAsset}
                  />
                </Box>
              ) : null}
              <Text variant={TextVariant.bodyMd} marginBottom={1}>
                {t('to')}
              </Text>
              <Box marginBottom={2}>
                <TextField
                  endAccessory={
                    pickerRecipients.length > 0 ? (
                      <ButtonIcon
                        ariaLabel={t('selectRecipient')}
                        data-testid="open-recipient-modal-btn"
                        iconName={IconName.Book}
                        onClick={openRecipientModal}
                        size={ButtonIconSize.Md}
                      />
                    ) : null
                  }
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder={t('recipientPlaceholderText')}
                  ref={recipientInputRef}
                  value={recipient}
                  width={BlockSize.Full}
                  size={TextFieldSize.Lg}
                  paddingRight={3}
                />
              </Box>
              <Box
                display={Display.Flex}
                flexDirection={FlexDirection.Row}
                alignItems={AlignItems.center}
                justifyContent={JustifyContent.spaceBetween}
                marginBottom={2}
                gap={2}
                className="min-w-0"
              >
                <Box className="min-w-0 flex-1">
                  <Text
                    variant={TextVariant.bodySm}
                    color="text-muted"
                    marginBottom={1}
                  >
                    {t('privateBalanceSendShieldedBalance')}
                  </Text>
                  {confidentialDecryptPending ? (
                    <Text variant={TextVariant.bodyMd}>
                      {t('privateBalanceDecryptInProgress')}
                    </Text>
                  ) : confidentialDecryptError ? (
                    <Text variant={TextVariant.bodySm} color="error-default">
                      {confidentialDecryptError}
                    </Text>
                  ) : confidentialBalanceDisplay ? (
                    <Text variant={TextVariant.bodyMd}>
                      {t('privateBalanceRevealed', [
                        confidentialBalanceMasked
                          ? t('privateBalanceMaskedPlaceholder')
                          : confidentialBalanceDisplay,
                        token.symbol,
                      ])}
                    </Text>
                  ) : (
                    <Text variant={TextVariant.bodyMd} color="text-muted">
                      {t('privateBalanceEncryptedHint')}
                    </Text>
                  )}
                </Box>
                <ButtonIcon
                  ariaLabel={
                    confidentialBalanceDisplay && !confidentialBalanceMasked
                      ? t('privateBalanceHide')
                      : t('privateBalanceReveal')
                  }
                  iconName={
                    confidentialBalanceDisplay && !confidentialBalanceMasked
                      ? IconName.EyeSlash
                      : IconName.Eye
                  }
                  onClick={() => void onConfidentialBalanceEyeClick()}
                  disabled={confidentialDecryptPending}
                  size={ButtonIconSize.Md}
                />
              </Box>
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
              <ButtonSecondary onClick={handleBack} block marginBottom={2}>
                {t('cancel')}
              </ButtonSecondary>
              <ButtonPrimary onClick={onSubmit} disabled={busy} block>
                {busy
                  ? t('privateBalanceSendSubmitting')
                  : t('privateBalanceSendSubmit')}
              </ButtonPrimary>
            </Box>
          </ScrollContainer>
        </Box>
      </Box>
      <Modal
        isClosedOnEscapeKey
        isClosedOnOutsideClick
        isOpen={recipientModalOpen}
        onClose={closeRecipientModal}
      >
        <ModalOverlay />
        <ModalContent size={ModalContentSize.Md}>
          <ModalHeader
            endAccessory={
              <ButtonIcon
                ariaLabel={t('close')}
                data-testid="close-recipient-modal-btn"
                iconName={IconName.Close}
                onClick={closeRecipientModal}
                size={ButtonIconSize.Sm}
              />
            }
          >
            {t('selectRecipient')}
          </ModalHeader>
          <ModalBody paddingRight={0} paddingLeft={0}>
            <RecipientList
              hideModal={closeRecipientModal}
              onToChange={onRecipientPicked}
              recipientsOverride={pickerRecipients}
            />
          </ModalBody>
        </ModalContent>
      </Modal>
    </Box>
  );
}
