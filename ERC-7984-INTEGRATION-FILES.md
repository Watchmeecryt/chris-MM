# ERC-7984 (Zama / confidential token) — file index

This document lists **new** and **modified** source paths for the shielded-balance integration. Paths are **relative to the `metamask-extension/` repository root**.

On **GitHub**, click any link to open that file in the browser. In **VS Code / Cursor**, `Ctrl`+click (or `Cmd`+click) the link if your editor resolves workspace-relative paths.

---

## New: `shared/lib/confidential-erc7984/`


| File                                                                     | Description                                        |
| ------------------------------------------------------------------------ | -------------------------------------------------- |
| [constants.ts](./shared/lib/confidential-erc7984/constants.ts)           | Relayer base URLs, REST path suffixes, chain IDs   |
| [registry.ts](./shared/lib/confidential-erc7984/registry.ts)             | Per-chain confidential token registry              |
| [relayer.ts](./shared/lib/confidential-erc7984/relayer.ts)               | Encrypt, user-decrypt, public decrypt HTTP helpers |
| [eip712.ts](./shared/lib/confidential-erc7984/eip712.ts)                 | EIP-712 normalization for user-decrypt             |
| [abi.ts](./shared/lib/confidential-erc7984/abi.ts)                       | ERC-7984 / ERC-20 ABI fragments                    |
| [unwrap-receipt.ts](./shared/lib/confidential-erc7984/unwrap-receipt.ts) | Parse `UnwrapRequested` handle from receipt logs   |


---

## New: asset UI


| File                                                                                                         | Description                       |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| [confidential-erc7984-balance-panel.tsx](./ui/pages/asset/components/confidential-erc7984-balance-panel.tsx) | Asset page shielded balance panel |
| [erc7984-wrapper-token-details.tsx](./ui/pages/asset/components/erc7984-wrapper-token-details.tsx)           | Wrapper address + supply figures  |


---

## New: private-balance flows


| File                                                                                                                  | Description                  |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| [confidential-send-page.tsx](./ui/pages/private-balance/confidential-send-page.tsx)                                   | Full-page confidential send  |
| [shield-page.tsx](./ui/pages/private-balance/shield-page.tsx)                                                         | Full-page shield / unwrap    |
| [unwrap-track-page.tsx](./ui/pages/private-balance/unwrap-track-page.tsx)                                             | Unwrap finalize milestone UI |
| [use-private-confidential-send-recipients.ts](./ui/pages/private-balance/use-private-confidential-send-recipients.ts) | Recipients for send route    |


---

## New: account overview (Shielded tab)


| File                                                                                                                                       | Description                           |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| [private-balance-tab.tsx](./ui/components/multichain/account-overview/private-balance-tab.tsx)                                             | Shielded tab rows and navigation      |
| [use-private-balance-unwrap-finalize-poller.ts](./ui/components/multichain/account-overview/use-private-balance-unwrap-finalize-poller.ts) | Redux-driven unwrap finalize pipeline |


---

## New: helpers


| File                                                                                              | Description                                                |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [confidential-erc7984-revealed-storage.ts](./ui/helpers/confidential-erc7984-revealed-storage.ts) | `browser.storage.local` for revealed balances / mask state |
| [private-balance-unwrap-session.ts](./ui/helpers/private-balance-unwrap-session.ts)               | Unwrap-track session persistence                           |


---

## Modified: integration touchpoints


| File                                                                                               | Description                                                      |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [metamask-controller.js](./app/scripts/metamask-controller.js)                                     | `eth_call`, receipt, EIP-712, confidential helpers exposed to UI |
| [actions.ts](./ui/store/actions.ts)                                                                | UI wrappers for controller confidential APIs                     |
| [asset-page.tsx](./ui/pages/asset/components/asset-page.tsx)                                       | Optional shielded panel wiring                                   |
| [token-asset.tsx](./ui/pages/asset/components/token-asset.tsx)                                     | Renders shielded panel when registered                           |
| [routes.component.tsx](./ui/pages/routes/routes.component.tsx)                                     | Routes for send / shield / unwrap-track                          |
| [routes.ts](./ui/helpers/constants/routes.ts)                                                      | Route path constants                                             |
| [account-overview-tabs.tsx](./ui/components/multichain/account-overview/account-overview-tabs.tsx) | Shielded tab + unwrap poller hints                               |
| [account-overview-eth.tsx](./ui/components/multichain/account-overview/account-overview-eth.tsx)   | `showPrivateConfidential`                                        |
| [app-state.ts](./shared/constants/app-state.ts)                                                    | `AccountOverviewTabKey.PrivateBalance`                           |
| [trace.ts](./shared/lib/trace.ts)                                                                  | Trace map entry for Shielded tab                                 |
| [messages.json](./app/_locales/en/messages.json)                                                   | English strings for shielded flows                               |
| [recipient-list.tsx](./ui/pages/confirmations/components/send/recipient-list/recipient-list.tsx)   | `recipientsOverride` for shielded send                           |


---

## Removed (do not restore)

These were replaced by full-page routes; they should **not** be re-added when porting:

- `ui/components/multichain/account-overview/private-balance-send-modal.tsx`
- `ui/components/multichain/account-overview/private-balance-wrap-modal.tsx`

