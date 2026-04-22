import {
  Box,
  BoxAlignItems,
  BoxFlexDirection,
  FontWeight,
  Text,
  TextVariant,
} from '@metamask/design-system-react';
import type { Hex } from '@metamask/utils';
import React, { useEffect, useState } from 'react';
import { decodeFunctionResult, encodeFunctionData, formatUnits } from 'viem';
import { ERC7984_WRAPPER_PUBLIC_READ_ABI } from '../../../../shared/lib/confidential-erc7984/abi';
import { AddressCopyButton } from '../../../components/multichain';
import { useI18nContext } from '../../../hooks/useI18nContext';
import { confidentialErc7984EthCall } from '../../../store/actions';

type Props = {
  chainId: Hex;
  wrapperAddress: string;
  decimals: number;
  symbol: string;
  underlyingDecimals?: number;
  underlyingFiatPerToken?: number;
  fiatCurrencyCode?: string;
};

function addThousandsSeparatorsToDecimalString(amountString: string): string {
  const trimmed = amountString.trim();
  if (!trimmed) {
    return amountString;
  }
  const neg = trimmed.startsWith('-');
  const body = neg ? trimmed.slice(1) : trimmed;
  const [intPart, frac] = body.split('.');
  if (intPart === undefined) {
    return amountString;
  }
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const combined =
    frac !== undefined && frac !== '' ? `${grouped}.${frac}` : grouped;
  return neg ? `-${combined}` : combined;
}

function formatFiatForDisplay(amount: number, currencyCode: string): string {
  const raw = currencyCode?.trim() || 'usd';
  const code = raw.length === 3 ? raw.toUpperCase() : 'USD';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${code} ${amount.toFixed(2)}`;
  }
}

/**
 * Wrapper address + TVS (`inferredTotalSupply` per Zama docs), optional fiat from collateral × price.
 */
export function Erc7984WrapperTokenDetails({
  chainId,
  wrapperAddress,
  decimals,
  symbol,
  underlyingDecimals: underlyingDecimalsProp,
  underlyingFiatPerToken,
  fiatCurrencyCode,
}: Props) {
  const t = useI18nContext();
  const [tvsLine, setTvsLine] = useState<string | null>(null);
  const [tvsFiatLine, setTvsFiatLine] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let supplyRaw: bigint;
      try {
        const inferredData = encodeFunctionData({
          abi: ERC7984_WRAPPER_PUBLIC_READ_ABI,
          functionName: 'inferredTotalSupply',
          args: [],
        });
        try {
          const raw = await confidentialErc7984EthCall(
            chainId,
            wrapperAddress,
            inferredData,
          );
          supplyRaw = decodeFunctionResult({
            abi: ERC7984_WRAPPER_PUBLIC_READ_ABI,
            data: raw as Hex,
            functionName: 'inferredTotalSupply',
          }) as bigint;
        } catch {
          const totalData = encodeFunctionData({
            abi: ERC7984_WRAPPER_PUBLIC_READ_ABI,
            functionName: 'totalSupply',
            args: [],
          });
          const raw = await confidentialErc7984EthCall(
            chainId,
            wrapperAddress,
            totalData,
          );
          supplyRaw = decodeFunctionResult({
            abi: ERC7984_WRAPPER_PUBLIC_READ_ABI,
            data: raw as Hex,
            functionName: 'totalSupply',
          }) as bigint;
        }
      } catch {
        if (!cancelled) {
          setTvsLine(null);
          setTvsFiatLine(null);
        }
        return;
      }

      let wrapperDecimals = decimals;
      try {
        const decData = encodeFunctionData({
          abi: ERC7984_WRAPPER_PUBLIC_READ_ABI,
          functionName: 'decimals',
          args: [],
        });
        const decRaw = await confidentialErc7984EthCall(
          chainId,
          wrapperAddress,
          decData,
        );
        const d = Number(
          decodeFunctionResult({
            abi: ERC7984_WRAPPER_PUBLIC_READ_ABI,
            data: decRaw as Hex,
            functionName: 'decimals',
          }),
        );
        if (Number.isFinite(d) && d >= 0 && d <= 255) {
          wrapperDecimals = d;
        }
      } catch {
        // registry `decimals` is fallback
      }

      let rateBig = 1n;
      try {
        const rateData = encodeFunctionData({
          abi: ERC7984_WRAPPER_PUBLIC_READ_ABI,
          functionName: 'rate',
          args: [],
        });
        const rateRaw = await confidentialErc7984EthCall(
          chainId,
          wrapperAddress,
          rateData,
        );
        rateBig = decodeFunctionResult({
          abi: ERC7984_WRAPPER_PUBLIC_READ_ABI,
          data: rateRaw as Hex,
          functionName: 'rate',
        }) as bigint;
      } catch {
        rateBig = 1n;
      }

      const uDec = underlyingDecimalsProp ?? decimals;
      const grouped = addThousandsSeparatorsToDecimalString(
        formatUnits(supplyRaw, wrapperDecimals),
      );

      if (!cancelled) {
        setTvsLine(t('privateBalanceTvsSupply', [grouped, symbol]));
      }

      let fiatFormatted: string | null = null;
      if (
        underlyingFiatPerToken !== undefined &&
        Number.isFinite(underlyingFiatPerToken)
      ) {
        try {
          const underlyingLockedRaw = supplyRaw * rateBig;
          const humanUnderlying = formatUnits(underlyingLockedRaw, uDec);
          const n = Number(humanUnderlying);
          if (Number.isFinite(n)) {
            fiatFormatted = formatFiatForDisplay(
              n * underlyingFiatPerToken,
              fiatCurrencyCode ?? 'usd',
            );
          }
        } catch {
          fiatFormatted = null;
        }
      }

      if (!cancelled) {
        setTvsFiatLine(fiatFormatted);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    chainId,
    wrapperAddress,
    decimals,
    symbol,
    underlyingDecimalsProp,
    underlyingFiatPerToken,
    fiatCurrencyCode,
  ]);

  return (
    <Box
      flexDirection={BoxFlexDirection.Column}
      gap={1}
      alignItems={BoxAlignItems.flexEnd}
      width="100%"
    >
      <AddressCopyButton address={wrapperAddress} shorten />
      {tvsLine !== null ? (
        <Box
          flexDirection={BoxFlexDirection.Column}
          gap={1}
          alignItems={BoxAlignItems.flexEnd}
        >
          <Text variant={TextVariant.BodyMd} fontWeight={FontWeight.Medium}>
            {tvsLine}
          </Text>
          {tvsFiatLine !== null ? (
            <Text variant={TextVariant.BodyMd} fontWeight={FontWeight.Medium}>
              {tvsFiatLine}
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}
