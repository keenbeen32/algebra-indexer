/** Load-or-create the Transaction row for an event. */
import type { Transaction } from "envio";
import { cid } from "../config/chains.js";
import { getTxGas } from "./effects.js";
import { ZERO_BI } from "./constants.js";

export function transactionId(chainId: number, hash: string): string {
  return cid(chainId, hash);
}

export async function loadTransaction(
  event: any,
  context: any,
): Promise<Transaction> {
  const id = transactionId(event.chainId, event.transaction.hash);

  let gasLimit = ZERO_BI;
  try {
    gasLimit = await context.effect(getTxGas, {
      chainId: event.chainId,
      hash: event.transaction.hash,
    });
  } catch (err) {
    context.log.error(
      `getTxGas failed for tx ${event.transaction.hash} on chain ${event.chainId} ` +
        `(block ${event.block.number}); Transaction.gasLimit falls back to 0. ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let gasPrice = event.transaction.gasPrice;
  if (gasPrice === undefined) {
    context.log.warn(
      `tx.gasPrice missing for ${event.transaction.hash} on chain ${event.chainId}; defaulting to 0`,
    );
    gasPrice = ZERO_BI;
  }

  const transaction: Transaction = {
    id,
    blockNumber: BigInt(event.block.number),
    timestamp: BigInt(event.block.timestamp),
    gasLimit,
    gasPrice,
  };

  context.Transaction.set(transaction);
  return transaction;
}
