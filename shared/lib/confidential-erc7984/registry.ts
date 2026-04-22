import { Hex, hexToBigInt } from '@metamask/utils';
import { MAINNET_CHAIN_ID, SEPOLIA_CHAIN_ID } from './constants';

/**
 * Confidential wrapper metadata — mainnet addresses match * `zpayy-mobile/src/lib/contracts.ts` (`MAINNET_CONTRACTS` CONF_* defaults).
 */
export type ConfidentialTokenDefinition = {
  id: string;
  symbol: string;
  decimals: number;
  address: `0x${string}`;
  /** Public ERC-20 paired with this confidential token (wrap / shield). */
  underlyingAddress?: `0x${string}`;
};

const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';

const MAINNET_CONFIDENTIAL_TOKENS: ConfidentialTokenDefinition[] = [
  {
    id: 'usdc',
    symbol: 'cUSDC',
    decimals: 6,
    address: '0xe978f22157048e5db8e5d07971376e86671672b2',
    underlyingAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  },
  {
    id: 'usdt',
    symbol: 'cUSDT',
    decimals: 6,
    address: '0xae0207c757aa2b4019ad96edd0092ddc63ef0c50',
    underlyingAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7',
  },
  {
    id: 'zama',
    symbol: 'cZAMA',
    decimals: 18,
    address: '0x80cb147fd86dc6dee3eee7e4cee33d1397d98071',
    underlyingAddress: '0xa12cc123ba206d4031d1c7f6223d1c2ec249f4f3',
  },
  {
    id: 'weth',
    symbol: 'cWETH',
    decimals: 18,
    address: '0xda9396b82634ea99243ce51258b6a5ae512d4893',
    underlyingAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  },
  {
    id: 'bron',
    symbol: 'cBRON',
    decimals: 18,
    address: '0x85de671c3bec1aded752c3cea943521181c826bc',
    underlyingAddress: '0xba2c598e11ed093079cc324fca5bbba99f616e83',
  },
  {
    id: 'tgbp',
    symbol: 'ctGBP',
    decimals: 18,
    address: '0xa873750ccbafd5ec7dd13bfd5237d7129832edd9',
    underlyingAddress: '0x27f6c8289550fce67f6b50bed1f519966afe5287',
  },
  {
    id: 'xaut',
    symbol: 'cXAUt',
    decimals: 6,
    address: '0x73cc9af9d6befdb3c3faf8a5e8c05cb95fdaeef1',
    underlyingAddress: '0x68749665ff8d2d112fa859aa293f07a622782f38',
  },
];

/** Sepolia: cUSDC from zpayy-mobile `SEPOLIA_CONTRACTS` default. */
const SEPOLIA_CONFIDENTIAL_TOKENS: ConfidentialTokenDefinition[] = [
  {
    id: 'usdc',
    symbol: 'cUSDC',
    decimals: 6,
    address: '0x6981762339f1064f660ee5a7b15a54382ed43e5a',
    underlyingAddress: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
  },
];

export const CONFIDENTIAL_TOKENS_BY_CHAIN: Record<
  number,
  ConfidentialTokenDefinition[]
> = {
  [MAINNET_CHAIN_ID]: MAINNET_CONFIDENTIAL_TOKENS,
  [SEPOLIA_CHAIN_ID]: SEPOLIA_CONFIDENTIAL_TOKENS,
};

export function getConfidentialTokensForChain(
  chainId: number,
): ConfidentialTokenDefinition[] {
  return CONFIDENTIAL_TOKENS_BY_CHAIN[chainId] ?? [];
}

/**
 * Public (underlying) ticker for shield UI when the registry uses a leading `c` prefix
 * (e.g. cUSDC → USDC, ctGBP → tGBP).
 */
export function getUnderlyingPublicDisplaySymbol(
  token: ConfidentialTokenDefinition,
): string {
  const { symbol } = token;
  if (symbol.length > 1 && symbol.startsWith('c')) {
    return symbol.slice(1);
  }
  return symbol;
}

export { ZERO as CONFIDENTIAL_ZERO_HANDLE };

export function isConfidentialErc7984Token(
  chainId: Hex,
  tokenAddress: string,
): boolean {
  const n = Number(hexToBigInt(chainId));
  const list = getConfidentialTokensForChain(n);
  return list.some(
    (t) => t.address.toLowerCase() === tokenAddress.toLowerCase(),
  );
}
