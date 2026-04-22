import { useMemo } from 'react';
import { useSelector } from 'react-redux';
import { hexToBigInt, type Hex } from '@metamask/utils';

import { getCompleteAddressBook } from '../../selectors';
import { selectEvmAddress } from '../../selectors/accounts';
import { getWalletsWithAccounts } from '../../selectors/multichain-accounts/account-tree';
import { isEVMAccountForSend } from '../confirmations/utils/account';
import { useAccountAddressSeedIconMap } from '../confirmations/hooks/send/useAccountAddressSeedIconMap';
import { type Recipient } from '../confirmations/hooks/send/useRecipients';

function chainIdMatchesBookEntry(contactChainId: string, chainIdHex: Hex) {
  try {
    const target = hexToBigInt(chainIdHex);
    const entry = contactChainId.startsWith('0x')
      ? hexToBigInt(contactChainId as Hex)
      : BigInt(contactChainId);
    return entry === target;
  } catch {
    return false;
  }
}

/**
 * All EVM accounts (Ledger, HD, etc.) except the active sender, plus address-book
 * contacts for the send chain — same data the send flow lists, without `SendContext`.
 */
export function usePrivateConfidentialSendRecipients(
  chainIdHex: Hex | undefined,
): Recipient[] {
  const walletsWithAccounts = useSelector(getWalletsWithAccounts);
  const from = (useSelector(selectEvmAddress) || '').toLowerCase();
  const addressBook = useSelector(getCompleteAddressBook);
  const { accountAddressSeedIconMap } = useAccountAddressSeedIconMap();

  return useMemo(() => {
    const recipients: Recipient[] = [];

    Object.values(walletsWithAccounts).forEach((wallet) => {
      const walletName = wallet.metadata?.name;

      Object.values(wallet.groups).forEach((group) => {
        const accountGroupName = group.metadata?.name;

        group.accounts.forEach((account) => {
          if (account.address.toLowerCase() === from) {
            return;
          }
          if (!isEVMAccountForSend(account)) {
            return;
          }
          recipients.push({
            seedIcon: accountAddressSeedIconMap.get(
              account.address.toLowerCase(),
            ),
            accountGroupName,
            accountType: account.type,
            address: account.address,
            walletName,
          });
        });
      });
    });

    if (chainIdHex) {
      (addressBook ?? []).forEach((contact) => {
        if (!chainIdMatchesBookEntry(contact.chainId, chainIdHex)) {
          return;
        }
        if (contact.address.toLowerCase() === from) {
          return;
        }
        if (
          recipients.some(
            (r) =>
              r.address.toLowerCase() === contact.address.toLowerCase(),
          )
        ) {
          return;
        }
        recipients.push({
          address: contact.address,
          contactName: contact.name,
          isContact: true,
          seedIcon: accountAddressSeedIconMap.get(
            contact.address.toLowerCase(),
          ),
        });
      });
    }

    return recipients;
  }, [
    addressBook,
    accountAddressSeedIconMap,
    chainIdHex,
    from,
    walletsWithAccounts,
  ]);
}
