import { Account, RpcProvider } from "starknet";
import { config } from "./config";

export const provider = new RpcProvider({ nodeUrl: config.nodeUrl });

export const account = new Account({
  provider,
  address: config.burnerAddress,
  signer: config.burnerPrivateKey,
});
