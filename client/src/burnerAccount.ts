import { Account, CallData, ec, hash, RpcProvider, stark } from "starknet";

const BURNER_KEY = "zordle_burner";
const BURNER_VERSION_KEY = "zordle_burner_version";
const BURNER_VERSION = "1";

const OZ_ACCOUNT_CLASS_HASH =
  "0x07dc7899aa655b0aae51eadff6d801a58e97dd99cf4666ee59e704249e51adf2";

type StoredBurner = {
  address: string;
  privateKey: string;
};

let createPromise: Promise<Account> | null = null;

const restoreBurner = async (provider: RpcProvider): Promise<Account | null> => {
  if (typeof window === "undefined") return null;
  if (localStorage.getItem(BURNER_VERSION_KEY) !== BURNER_VERSION) return null;
  const raw = localStorage.getItem(BURNER_KEY);
  if (!raw) return null;

  try {
    const burner = JSON.parse(raw) as StoredBurner;
    if (!burner.address || !burner.privateKey) return null;
    await provider.getClassAt(burner.address);
    return new Account({
      provider,
      address: burner.address,
      signer: burner.privateKey,
    });
  } catch {
    localStorage.removeItem(BURNER_KEY);
    localStorage.removeItem(BURNER_VERSION_KEY);
    return null;
  }
};

export const getOrCreateBurner = async (provider: RpcProvider): Promise<Account> => {
  const restored = await restoreBurner(provider);
  if (restored) return restored;
  if (createPromise) return createPromise;

  createPromise = (async () => {
    const privateKey = stark.randomAddress();
    const publicKey = ec.starkCurve.getStarkKey(privateKey);
    const constructorCalldata = CallData.compile({ publicKey });
    const address = hash.calculateContractAddressFromHash(
      publicKey,
      OZ_ACCOUNT_CLASS_HASH,
      constructorCalldata,
      0,
    );

    const account = new Account({
      provider,
      address,
      signer: privateKey,
    });

    const { transaction_hash } = await account.deployAccount({
      classHash: OZ_ACCOUNT_CLASS_HASH,
      constructorCalldata,
      addressSalt: publicKey,
    });
    await account.waitForTransaction(transaction_hash, { retryInterval: 100 });

    localStorage.setItem(BURNER_KEY, JSON.stringify({ address, privateKey }));
    localStorage.setItem(BURNER_VERSION_KEY, BURNER_VERSION);

    return account;
  })();

  try {
    return await createPromise;
  } finally {
    createPromise = null;
  }
};
