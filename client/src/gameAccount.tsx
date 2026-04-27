import { useAccount, useConnect } from "@starknet-react/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Account, AccountInterface } from "starknet";
import { providerForNetwork, type GameMode, type ZordleNetwork } from "./networkConfig";
import { getOrCreateBurner } from "./burnerAccount";

export type GameAccountState = {
  account: AccountInterface | Account | null;
  address: string | null;
  error: Error | null;
  isConnected: boolean;
  isReady: boolean;
  isPending: boolean;
  login: () => void;
};

export const useGameAccount = (
  mode: GameMode,
  network: ZordleNetwork,
): GameAccountState => {
  const {
    account: controllerAccount,
    address: controllerAddress,
    isConnected: controllerConnected,
    isConnecting,
  } = useAccount();
  const { connect, connectors, isPending: connectPending } = useConnect();
  const [burner, setBurner] = useState<Account | null>(null);
  const [burnerPending, setBurnerPending] = useState(false);
  const [burnerError, setBurnerError] = useState<Error | null>(null);

  const provider = useMemo(() => providerForNetwork(network), [network.rpcUrl]);

  useEffect(() => {
    if (mode !== "practice") return;

    let cancelled = false;
    setBurnerPending(true);
    setBurnerError(null);
    getOrCreateBurner(provider)
      .then((account) => {
        if (!cancelled) setBurner(account);
      })
      .catch((err) => {
        if (!cancelled) setBurnerError(err as Error);
      })
      .finally(() => {
        if (!cancelled) setBurnerPending(false);
      });

    return () => {
      cancelled = true;
    };
  }, [mode, provider]);

  const login = useCallback(() => {
    if (mode === "practice") return;
    const ctrl = connectors.find((c) => c.id === "controller") ?? connectors[0];
    if (ctrl) connect({ connector: ctrl });
  }, [connect, connectors, mode]);

  if (mode === "practice") {
    return {
      account: burner,
      address: burner?.address ?? null,
      error: burnerError,
      isConnected: !!burner,
      isReady: !!burner && !burnerPending && !burnerError,
      isPending: burnerPending,
      login,
    };
  }

  return {
    account: controllerAccount ?? null,
    address: controllerAddress ?? null,
    error: null,
    isConnected: !!controllerConnected,
    isReady: !!controllerConnected && !!controllerAccount && !!controllerAddress,
    isPending: isConnecting || connectPending,
    login,
  };
};
