import React, { useCallback } from 'react';
import { useSelector } from 'react-redux';
import { Navigate, useNavigate } from 'react-router-dom';
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
  IconName,
  Text,
} from '../../components/component-library';
import { ScrollContainer } from '../../contexts/scroll-container';
import { DEFAULT_ROUTE } from '../../helpers/constants/routes';
import { readPrivateBalanceUnwrapFinalizeSession } from '../../helpers/private-balance-unwrap-session';
import { useI18nContext } from '../../hooks/useI18nContext';
import { selectEvmAddress } from '../../selectors/accounts';
import { useConfidentialHandleCacheSync } from '../../hooks/useConfidentialHandleCacheSync';
import { usePrivateBalanceUnwrapFinalizePoller } from '../../components/multichain/account-overview/use-private-balance-unwrap-finalize-poller';

/**
 * Full page shown after the user approves the **unwrap** transaction.
 *
 * Flow (per Zama confidential-wrapper docs):
 *  1. Wait for the unwrap tx to be `confirmed` (via MetaMask's own `TransactionController` Redux state).
 *  2. Pull the receipt → parse the burnt-handle event.
 *  3. Ask the relayer for a public-decryption proof.
 *  4. Queue `finalizeUnwrap(burntHandle, cleartext, proof)` and route to the confirmation screen.
 *
 * No polling, no buttons, no manual nudges — just status text.
 */
export default function PrivateBalanceUnwrapTrackPage() {
  const t = useI18nContext();
  const navigate = useNavigate();
  const evmAddress = useSelector(selectEvmAddress);

  const { unwrapFinalizeHint, setUnwrapFinalizeHint } =
    usePrivateBalanceUnwrapFinalizePoller(Boolean(evmAddress));

  useConfidentialHandleCacheSync(Boolean(evmAddress));

  const hasSession = readPrivateBalanceUnwrapFinalizeSession() !== null;

  const onBack = useCallback(() => {
    setUnwrapFinalizeHint(null);
    navigate(DEFAULT_ROUTE);
  }, [navigate, setUnwrapFinalizeHint]);

  if (!evmAddress) {
    return <Navigate to={DEFAULT_ROUTE} replace />;
  }

  const bodyText =
    unwrapFinalizeHint ??
    (hasSession
      ? t('privateBalanceUnwrapTrackStatusIdle')
      : t('privateBalanceUnwrapTrackNoSession'));

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
              onClick={onBack}
              size={ButtonIconSize.Sm}
            />
            <Text variant={TextVariant.headingSm}>
              {t('privateBalanceUnwrapTrackTitle')}
            </Text>
          </Box>
          <ScrollContainer className="redesigned__send__content-wrapper">
            <Box
              display={Display.Flex}
              flexDirection={FlexDirection.Column}
              marginTop={2}
              marginBottom={2}
              padding={4}
              style={{ gap: 12 }}
            >
              <Text variant={TextVariant.bodyMd} marginBottom={2}>
                {t('privateBalanceUnwrapTrackIntro')}
              </Text>
              <Box
                display={Display.Flex}
                flexDirection={FlexDirection.Column}
                gap={2}
                padding={4}
                borderRadius={BorderRadius.MD}
                backgroundColor={BackgroundColor.backgroundDefault}
                data-testid="private-balance-unwrap-track__status"
              >
                <Text variant={TextVariant.bodyMd}>{bodyText}</Text>
              </Box>
            </Box>
          </ScrollContainer>
        </Box>
      </Box>
    </Box>
  );
}
