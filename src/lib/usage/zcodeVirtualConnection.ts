/** The dashboard/cache identity for ZCode Start's already-authenticated local account. */
export const ZCODE_START_VIRTUAL_CONNECTION_ID = "virtual:zcode-start";

export interface ZcodeStartVirtualConnection {
  id: typeof ZCODE_START_VIRTUAL_CONNECTION_ID;
  provider: "zcode-start";
  authType: "none";
  isActive: true;
  name: "ZCode Start";
}

export function createZcodeStartVirtualConnection(): ZcodeStartVirtualConnection {
  return {
    id: ZCODE_START_VIRTUAL_CONNECTION_ID,
    provider: "zcode-start",
    authType: "none",
    isActive: true,
    name: "ZCode Start",
  };
}

export function isZcodeStartVirtualConnection(
  value:
    | {
        id?: string;
        provider?: string;
        authType?: string;
      }
    | null
    | undefined
): value is ZcodeStartVirtualConnection {
  return (
    value?.id === ZCODE_START_VIRTUAL_CONNECTION_ID &&
    value.provider === "zcode-start" &&
    value.authType === "none"
  );
}
