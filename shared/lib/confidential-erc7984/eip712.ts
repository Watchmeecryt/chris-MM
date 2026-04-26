/** Normalizes relayer EIP-712 payloads for Zama user-decrypt (`eth_signTypedData_v4`). */

export function toTypedDataV4Params(eip712: Record<string, unknown>) {
  const { domain, types, message, primaryType } = eip712;
  const domainObj = (domain ?? {}) as Record<string, unknown>;
  const chainId = domainObj.chainId;
  const domainNormalized =
    chainId !== undefined
      ? {
          ...domainObj,
          chainId:
            typeof chainId === 'string' ? parseInt(chainId, 10) : Number(chainId),
        }
      : domainObj;
  const msg = (message ?? {}) as Record<string, unknown>;
  const messageNormalized = { ...msg };
  if (typeof messageNormalized.startTimestamp === 'string') {
    messageNormalized.startTimestamp = parseInt(
      messageNormalized.startTimestamp as string,
      10,
    );
  }
  if (typeof messageNormalized.durationDays === 'string') {
    messageNormalized.durationDays = parseInt(
      messageNormalized.durationDays as string,
      10,
    );
  }
  return {
    domain: domainNormalized,
    types: (types as Record<string, unknown>) ?? {},
    message: messageNormalized,
    primaryType: primaryType ?? 'UserDecryptRequestVerification',
  };
}

function sortKeys(o: unknown): unknown {
  if (o !== null && typeof o === 'object' && !Array.isArray(o)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(o as object).sort()) {
      sorted[k] = sortKeys((o as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return o;
}

export function canonicalStringify(obj: unknown): string {
  return JSON.stringify(sortKeys(obj));
}
