import { CallData } from "starknet";
import { account, provider } from "./account";
import { config } from "./config";
import { parseReceipt, type ReceiptParsed } from "./receipts";
import { decodeDictionary, type Dictionary } from "./state";

const target = config.actionsAddress;

async function view(entrypoint: string, calldata: any[]): Promise<string[]> {
  return await provider.callContract({
    contractAddress: target,
    entrypoint,
    calldata: CallData.compile(calldata),
  });
}

async function execute(
  entrypoint: string,
  calldata: any[],
  gameId: bigint,
): Promise<ReceiptParsed> {
  console.log(`[zordle] execute(${entrypoint})`, { gameId: gameId.toString(16), calldata });
  const t0 = performance.now();
  const { transaction_hash } = await account.execute({
    contractAddress: target,
    entrypoint,
    calldata: CallData.compile(calldata),
  });
  console.log(`[zordle] tx submitted in ${(performance.now() - t0).toFixed(0)}ms`, { transaction_hash });

  const t1 = performance.now();
  const receipt: any = await provider.waitForTransaction(transaction_hash);
  console.log(`[zordle] receipt received in ${(performance.now() - t1).toFixed(0)}ms`, {
    status: receipt?.execution_status ?? receipt?.statusReceipt ?? "?",
    eventCount: receipt?.events?.length ?? 0,
    receipt,
  });

  const parsed = parseReceipt(receipt, gameId);
  console.log(`[zordle] parsed`, parsed);
  return parsed;
}

// --- writes (return parsed receipt state) -----------------------------

export function startGame(gameId: bigint): Promise<ReceiptParsed> {
  return execute("start_game", [gameId], gameId);
}

export function submitGuess(
  gameId: bigint,
  wordId: number,
): Promise<ReceiptParsed> {
  return execute("guess", [gameId, wordId], gameId);
}

export function surrender(gameId: bigint): Promise<ReceiptParsed> {
  return execute("surrender", [gameId], gameId);
}

// --- read used only at boot to confirm chain is ready -----------------

export async function getDictionary(): Promise<Dictionary> {
  return decodeDictionary(await view("get_dictionary", []));
}

// --- random felt for game ids -----------------------------------------

export function randomFelt(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  // Clamp to < 2^252 (felt252 range).
  bytes[0] &= 0x0f;
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return BigInt(hex);
}
