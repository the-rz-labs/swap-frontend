import {
  USDT_TRON_ADDRESS,
  isTronToken,
  type Token,
} from "./tokens";
import { isTronAddress } from "./tron/tronAddress";
import {
  getRelayQuote,
  relayOutputAmount,
  relayMinimumOutput,
  relayUsd,
  relayFeeUsd,
} from "./relay";
import { classify, applySlippage } from "./swapPlan";

export type QuoteResult = {
  /** Expected final output in destination-token base units (UI "You receive"). */
  output: bigint;
  /** Guaranteed floor: Relay minimum when present, else output × (1 − slippage). */
  minOutput: bigint;
  inputUsd?: number;
  outputUsd?: number;
  bridgeFeeUsd?: number;
};

function quoteRecipient(to: Token, recipient: string | undefined): string | undefined {
  if (!isTronToken(to)) return recipient;
  return recipient && isTronAddress(recipient) ? recipient : USDT_TRON_ADDRESS;
}

/** Read-only Relay quote for any supported from/to pair (no custom dest txs). */
export async function computeRelayOnlyQuote(
  from: Token,
  to: Token,
  amountIn: bigint,
  recipient: string | undefined,
  slippageBps: number,
): Promise<QuoteResult> {
  if (classify(from, to) === "invalid") {
    throw new Error("Unsupported pair.");
  }

  const quote = await getRelayQuote({
    fromChainId: from.chainId,
    fromCurrency: from.address,
    toChainId: to.chainId,
    toCurrency: to.address,
    amount: amountIn.toString(),
    recipient: quoteRecipient(to, recipient),
    user: isTronToken(from) ? USDT_TRON_ADDRESS : undefined,
  });

  const output = relayOutputAmount(quote);
  if (output == null) throw new Error("Relay returned no output amount.");

  const minOutput = relayMinimumOutput(quote) ?? applySlippage(output, slippageBps);
  const { inUsd, outUsd } = relayUsd(quote);

  return {
    output,
    minOutput,
    inputUsd: inUsd,
    outputUsd: outUsd,
    bridgeFeeUsd: relayFeeUsd(quote),
  };
}
