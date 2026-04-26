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
  FontWeight,
  IconColor,
  JustifyContent,
  TextColor,
  TextVariant,
} from '../../helpers/constants/design-system';
import {
  Box,
  ButtonIcon,
  ButtonIconSize,
  Icon,
  IconName,
  IconSize,
  Text,
} from '../../components/component-library';
import Spinner from '../../components/ui/spinner';
import { ScrollContainer } from '../../contexts/scroll-container';
import { DEFAULT_ROUTE } from '../../helpers/constants/routes';
import { readPrivateBalanceUnwrapFinalizeSession } from '../../helpers/private-balance-unwrap-session';
import { useI18nContext } from '../../hooks/useI18nContext';
import { selectEvmAddress } from '../../selectors/accounts';
import { useConfidentialHandleCacheSync } from '../../hooks/useConfidentialHandleCacheSync';
import {
  type FinalizeStepIndex,
  usePrivateBalanceUnwrapFinalizePoller,
} from '../../components/multichain/account-overview/use-private-balance-unwrap-finalize-poller';

type StepState = 'pending' | 'active' | 'done' | 'failed';

type TrackerStep = {
  index: FinalizeStepIndex;
  state: StepState;
  title: string;
  description: string;
};

const TRACKER_COLORS = {
  done: 'var(--color-success-default)',
  active: 'var(--color-primary-default)',
  failed: 'var(--color-error-default)',
  pending: 'var(--color-icon-muted)',
};

function StepCircle({ state }: { state: StepState }) {
  const baseSize = 28;
  const borderColor = TRACKER_COLORS[state];
  const fillColor =
    state === 'done'
      ? TRACKER_COLORS.done
      : state === 'failed'
        ? TRACKER_COLORS.failed
        : 'transparent';

  return (
    <Box
      style={{
        width: baseSize,
        height: baseSize,
        borderRadius: '50%',
        border: `2px solid ${borderColor}`,
        backgroundColor: fillColor,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
        transition:
          'background-color 200ms ease, border-color 200ms ease',
      }}
      aria-hidden
    >
      {state === 'active' && (
        <Box style={{ width: 14, height: 14, lineHeight: 0 }}>
          <Spinner color="var(--color-primary-default)" />
        </Box>
      )}
      {state === 'done' && (
        <Icon
          name={IconName.Check}
          size={IconSize.Sm}
          color={IconColor.successInverse}
        />
      )}
      {state === 'failed' && (
        <Icon
          name={IconName.Close}
          size={IconSize.Sm}
          color={IconColor.errorInverse}
        />
      )}
    </Box>
  );
}

function StepConnector({ done }: { done: boolean }) {
  return (
    <Box
      style={{
        width: 2,
        flex: '1 1 auto',
        minHeight: 28,
        backgroundColor: done
          ? TRACKER_COLORS.done
          : TRACKER_COLORS.pending,
        marginTop: 4,
        marginBottom: 4,
        transition: 'background-color 200ms ease',
      }}
      aria-hidden
    />
  );
}

function MilestoneRow({
  step,
  isLast,
}: {
  step: TrackerStep;
  isLast: boolean;
}) {
  const titleColor =
    step.state === 'pending'
      ? TextColor.textMuted
      : step.state === 'failed'
        ? TextColor.errorDefault
        : TextColor.textDefault;
  const descriptionColor =
    step.state === 'pending'
      ? TextColor.textMuted
      : step.state === 'failed'
        ? TextColor.errorDefault
        : TextColor.textAlternative;

  return (
    <Box display={Display.Flex} style={{ gap: 12, minHeight: 56 }}>
      <Box
        display={Display.Flex}
        flexDirection={FlexDirection.Column}
        alignItems={AlignItems.center}
        style={{ width: 28, flex: '0 0 auto' }}
      >
        <StepCircle state={step.state} />
        {!isLast && (
          <StepConnector done={step.state === 'done'} />
        )}
      </Box>
      <Box
        display={Display.Flex}
        flexDirection={FlexDirection.Column}
        style={{ gap: 2, paddingTop: 2, paddingBottom: 16 }}
      >
        <Text
          variant={TextVariant.bodyMdMedium}
          color={titleColor}
          fontWeight={FontWeight.Medium}
        >
          {step.title}
        </Text>
        <Text variant={TextVariant.bodySm} color={descriptionColor}>
          {step.description}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Full page shown after the user approves the **unwrap** transaction.
 *
 * Renders a 3-step milestone tracker driven by
 * `usePrivateBalanceUnwrapFinalizePoller`:
 *
 *  1. Confirming on-chain — waits for the unwrap tx to be `confirmed`.
 *  2. Public decryption — fetches the receipt + relayer proof for the burnt handle.
 *  3. Finalize unwrap — queues `finalizeUnwrap(...)` and routes to confirmation.
 *
 * No polling, no buttons — milestone state comes from MetaMask's own
 * `TransactionController` Redux state via the hook.
 */
export default function PrivateBalanceUnwrapTrackPage() {
  const t = useI18nContext();
  const navigate = useNavigate();
  const evmAddress = useSelector(selectEvmAddress);

  const {
    activeStep,
    failedStep,
    errorText,
    setUnwrapFinalizeHint,
  } = usePrivateBalanceUnwrapFinalizePoller(Boolean(evmAddress));

  useConfidentialHandleCacheSync(Boolean(evmAddress));

  const hasSession = readPrivateBalanceUnwrapFinalizeSession() !== null;

  const onBack = useCallback(() => {
    setUnwrapFinalizeHint(null);
    navigate(DEFAULT_ROUTE);
  }, [navigate, setUnwrapFinalizeHint]);

  if (!evmAddress) {
    return <Navigate to={DEFAULT_ROUTE} replace />;
  }

  const stepStateFor = (idx: FinalizeStepIndex): StepState => {
    if (failedStep === idx) {
      return 'failed';
    }
    if (failedStep !== null) {
      return idx < failedStep ? 'done' : 'pending';
    }
    if (activeStep === null) {
      return hasSession ? 'pending' : 'pending';
    }
    if (idx < activeStep) {
      return 'done';
    }
    if (idx === activeStep) {
      return 'active';
    }
    return 'pending';
  };

  const steps: TrackerStep[] = [
    {
      index: 1,
      state: stepStateFor(1),
      title: t('privateBalanceUnwrapTrackStep1Title'),
      description:
        stepStateFor(1) === 'done'
          ? t('privateBalanceUnwrapTrackStep1Done')
          : t('privateBalanceUnwrapTrackStep1Pending'),
    },
    {
      index: 2,
      state: stepStateFor(2),
      title: t('privateBalanceUnwrapTrackStep2Title'),
      description:
        stepStateFor(2) === 'done'
          ? t('privateBalanceUnwrapTrackStep2Done')
          : t('privateBalanceUnwrapTrackStep2Pending'),
    },
    {
      index: 3,
      state: stepStateFor(3),
      title: t('privateBalanceUnwrapTrackStep3Title'),
      description:
        stepStateFor(3) === 'done'
          ? t('privateBalanceUnwrapTrackStep3Done')
          : t('privateBalanceUnwrapTrackStep3Pending'),
    },
  ];

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
              style={{ gap: 16 }}
            >
              <Text
                variant={TextVariant.bodyMd}
                color={TextColor.textAlternative}
              >
                {hasSession || activeStep !== null || failedStep !== null
                  ? t('privateBalanceUnwrapTrackIntro')
                  : t('privateBalanceUnwrapTrackNoSession')}
              </Text>

              {(hasSession || activeStep !== null || failedStep !== null) && (
                <Box
                  display={Display.Flex}
                  flexDirection={FlexDirection.Column}
                  padding={4}
                  paddingBottom={2}
                  borderRadius={BorderRadius.MD}
                  backgroundColor={BackgroundColor.backgroundDefault}
                  data-testid="private-balance-unwrap-track__milestones"
                >
                  {steps.map((step, idx) => (
                    <MilestoneRow
                      key={step.index}
                      step={step}
                      isLast={idx === steps.length - 1}
                    />
                  ))}
                </Box>
              )}

              {failedStep !== null && errorText && (
                <Box
                  padding={3}
                  borderRadius={BorderRadius.MD}
                  backgroundColor={BackgroundColor.errorMuted}
                  data-testid="private-balance-unwrap-track__error"
                  display={Display.Flex}
                  flexDirection={FlexDirection.Column}
                  style={{ gap: 2 }}
                >
                  <Text
                    variant={TextVariant.bodySm}
                    color={TextColor.errorDefault}
                    fontWeight={FontWeight.Medium}
                  >
                    {t('privateBalanceUnwrapTrackStepFailed')}
                  </Text>
                  <Text
                    variant={TextVariant.bodyXs}
                    color={TextColor.errorDefault}
                  >
                    {errorText}
                  </Text>
                </Box>
              )}
            </Box>
          </ScrollContainer>
        </Box>
      </Box>
    </Box>
  );
}
