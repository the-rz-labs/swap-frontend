"use client";

import { useQuery } from "@tanstack/react-query";
import {
  BSC_CHAIN_ID,
  ETH_CHAIN_ID,
  USDT_BSC,
  USDT_ETH,
  GOLDGR,
  USDT_TRON_ADDRESS,
  isTronToken,
  isBscToken,
  tokenKey,
  type Token,
} from "@/lib/tokens";
import { isTronAddress } from "@/lib/tron/tronAddress";
import { resolveBestBscPath, resolveEthGoldgrPath, bscUsdValue, ethUsdValue } from "@/lib/route";
import { getRelayQuote, relayOutputAmount, relayUsd, relayFeeUsd } from "@/lib/relay";
import { classify } from "@/lib/swapPlan";

export type QuoteResult = {
  /** Final output in destination-token base units. */
  output: bigint;
  /** USDT hub amount on the relevant hub, when the route passes through a hub. */
  hubAmount?: bigint;
  /** Best-effort USD value of the input / output. */
  inputUsd?: number;
  outputUsd?: number;
  /** Cross-chain bridge fee in USD (Relay), when the route crosses chains. */
  bridgeFeeUsd?: number;
};

async function computeGoldgrQuote(
  from: Token,
  to: Token,
  amountIn: bigint,
  recipient: string | undefined,
): Promise<QuoteResult> {
  const kind = classify(from, to);

  if (kind === "local-eth") {
    const { amountOut } = await resolveEthGoldgrPath(amountIn, from, to);
    const [inputUsd, outputUsd] = await Promise.all([ethUsdValue(from, amountIn), ethUsdValue(to, amountOut)]);
    return { output: amountOut, inputUsd, outputUsd };
  }

  if (kind === "buy-goldgr") {
    // Source → USDT(ETH) via Relay, then ETH treasury USDT → GOLDGR.
    const quote = await getRelayQuote({
      fromChainId: from.chainId,
      fromCurrency: from.address,
      toChainId: ETH_CHAIN_ID,
      toCurrency: USDT_ETH.address,
      amount: amountIn.toString(),
      recipient,
      user: isTronToken(from) ? USDT_TRON_ADDRESS : undefined,
    });
    const hubAmount = relayOutputAmount(quote);
    if (hubAmount == null) throw new Error("Relay returned no output amount.");
    const { inUsd, outUsd } = relayUsd(quote);
    const { amountOut } = await resolveEthGoldgrPath(hubAmount, USDT_ETH, GOLDGR);
    return { output: amountOut, hubAmount, inputUsd: inUsd, outputUsd: outUsd, bridgeFeeUsd: relayFeeUsd(quote) };
  }

  if (kind === "bsc-to-goldgr") {
    // CAR → USDT(BSC) → Relay → USDT(ETH) → GOLDGR
    const { amountOut: hubBsc } = await resolveBestBscPath(amountIn, from.address, USDT_BSC.address);
    const quote = await getRelayQuote({
      fromChainId: BSC_CHAIN_ID,
      fromCurrency: USDT_BSC.address,
      toChainId: ETH_CHAIN_ID,
      toCurrency: USDT_ETH.address,
      amount: hubBsc.toString(),
      recipient,
    });
    const hubEth = relayOutputAmount(quote);
    if (hubEth == null) throw new Error("Relay returned no output amount.");
    const { amountOut } = await resolveEthGoldgrPath(hubEth, USDT_ETH, GOLDGR);
    const { inUsd, outUsd } = relayUsd(quote);
    return { output: amountOut, hubAmount: hubEth, inputUsd: inUsd, outputUsd: outUsd, bridgeFeeUsd: relayFeeUsd(quote) };
  }

  // sell-goldgr
  const { amountOut: hubEth } = await resolveEthGoldgrPath(amountIn, GOLDGR, USDT_ETH);

  if (isBscToken(to) && tokenKey(to) !== tokenKey(USDT_BSC)) {
    // GOLDGR → USDT(ETH) → Relay → USDT(BSC) → token
    const quote = await getRelayQuote({
      fromChainId: ETH_CHAIN_ID,
      fromCurrency: USDT_ETH.address,
      toChainId: BSC_CHAIN_ID,
      toCurrency: USDT_BSC.address,
      amount: hubEth.toString(),
      recipient,
    });
    const hubBsc = relayOutputAmount(quote);
    if (hubBsc == null) throw new Error("Relay returned no output amount.");
    const { amountOut } = await resolveBestBscPath(hubBsc, USDT_BSC.address, to.address);
    const { inUsd, outUsd } = relayUsd(quote);
    return { output: amountOut, hubAmount: hubEth, inputUsd: inUsd, outputUsd: outUsd, bridgeFeeUsd: relayFeeUsd(quote) };
  }

  // GOLDGR → remote (incl. USDT BSC / Tron / ETH USDC / ETH native)
  const quoteRecipient = isTronToken(to)
    ? recipient && isTronAddress(recipient)
      ? recipient
      : USDT_TRON_ADDRESS
    : recipient;
  const quote = await getRelayQuote({
    fromChainId: ETH_CHAIN_ID,
    fromCurrency: USDT_ETH.address,
    toChainId: to.chainId,
    toCurrency: to.address,
    amount: hubEth.toString(),
    recipient: quoteRecipient,
  });
  const output = relayOutputAmount(quote);
  if (output == null) throw new Error("Relay returned no output amount.");
  const { inUsd, outUsd } = relayUsd(quote);
  return { output, hubAmount: hubEth, inputUsd: inUsd, outputUsd: outUsd, bridgeFeeUsd: relayFeeUsd(quote) };
}

async function computeQuote(
  from: Token,
  to: Token,
  amountIn: bigint,
  recipient: string | undefined,
): Promise<QuoteResult> {
  const kind = classify(from, to);

  if (
    kind === "local-eth" ||
    kind === "buy-goldgr" ||
    kind === "sell-goldgr" ||
    kind === "bsc-to-goldgr"
  ) {
    return computeGoldgrQuote(from, to, amountIn, recipient);
  }

  if (kind === "local") {
    const { amountOut } = await resolveBestBscPath(amountIn, from.address, to.address);
    const [inputUsd, outputUsd] = await Promise.all([bscUsdValue(from, amountIn), bscUsdValue(to, amountOut)]);
    return { output: amountOut, inputUsd, outputUsd };
  }

  // Cross-chain estimate: a connected wallet is NOT required. relay-sdk fills the destination chain's
  // dead address when no recipient is given (the output amount is recipient-independent). For a Tron
  // destination we still pass a funded placeholder when the real address isn't entered yet, because the
  // Tron delivery fee depends on the recipient (a fresh TRC-20 account pays a one-time activation cost).

  if (kind === "outbound") {
    const hubIsEndpoint = tokenKey(from) === tokenKey(USDT_BSC);
    const hubAmount = hubIsEndpoint
      ? amountIn
      : (await resolveBestBscPath(amountIn, from.address, USDT_BSC.address)).amountOut;
    const quoteRecipient = isTronToken(to)
      ? recipient && isTronAddress(recipient)
        ? recipient
        : USDT_TRON_ADDRESS
      : recipient;
    const quote = await getRelayQuote({
      fromChainId: BSC_CHAIN_ID,
      fromCurrency: USDT_BSC.address,
      toChainId: to.chainId,
      toCurrency: to.address,
      amount: hubAmount.toString(),
      recipient: quoteRecipient,
    });
    const output = relayOutputAmount(quote);
    if (output == null) throw new Error("Relay returned no output amount.");
    const { inUsd, outUsd } = relayUsd(quote);
    return { output, hubAmount, inputUsd: inUsd, outputUsd: outUsd, bridgeFeeUsd: relayFeeUsd(quote) };
  }

  // inbound
  const hubIsEndpoint = tokenKey(to) === tokenKey(USDT_BSC);
  // The SDK can't derive a dead address for Tron origin (it doesn't know the chain), so it would send
  // an invalid EVM zero address as `user`. Pass a valid Tron source for the estimate; at execution the
  // connected Tron wallet supplies the real `user`.
  const quote = await getRelayQuote({
    fromChainId: from.chainId,
    fromCurrency: from.address,
    toChainId: BSC_CHAIN_ID,
    toCurrency: USDT_BSC.address,
    amount: amountIn.toString(),
    recipient,
    user: isTronToken(from) ? USDT_TRON_ADDRESS : undefined,
  });
  const hubAmount = relayOutputAmount(quote);
  if (hubAmount == null) throw new Error("Relay returned no output amount.");
  const { inUsd, outUsd } = relayUsd(quote);

  // Plain bridge to USDT — the user receives ~expected, no on-arrival swap.
  if (hubIsEndpoint) return { output: hubAmount, hubAmount, inputUsd: inUsd, outputUsd: outUsd, bridgeFeeUsd: relayFeeUsd(quote) };

  // Buy: the fill swaps the bridged USDT into the token via RzSwap, so quote the token output from
  // the expected bridged USDT amount.
  const { amountOut } = await resolveBestBscPath(hubAmount, USDT_BSC.address, to.address);
  return { output: amountOut, hubAmount, inputUsd: inUsd, outputUsd: outUsd, bridgeFeeUsd: relayFeeUsd(quote) };
}

export function useQuote(from: Token, to: Token, amountIn: bigint, recipient: string | undefined) {
  return useQuery<QuoteResult>({
    queryKey: ["quote", tokenKey(from), tokenKey(to), amountIn.toString(), recipient ?? "anon"],
    queryFn: () => computeQuote(from, to, amountIn, recipient),
    enabled: amountIn > 0n && tokenKey(from) !== tokenKey(to),
    staleTime: 8_000,
    refetchInterval: 15_000,
    retry: 0,
  });
}
