// SPDX-License-Identifier: Apache-2.0
//
// Governed connection wrapper (Option 2 — consistent rate governance).
//
// The SDK's activity derivation (`deriveLastSwapEvidenceV4`) issues its
// own RPC calls through a `Connection` instance (signature retrieval,
// transaction retrieval, account reads). Those calls previously bypassed
// the process-global rate governor entirely, so a production run could
// stampede the provider from the activity path even while enrichment and
// discovery traffic were governed.
//
// `governedConnection` wraps a Connection in a Proxy that routes the RPC
// methods the derivation actually uses through the SAME process-global
// governor (`rpcTransport.governed`) used by discovery and enrichment —
// bounded concurrency and minimum spacing per endpoint kind, without
// touching the SDK (no cross-repository change, no semantic change: the
// wrapped methods are invoked identically; only their issuance is
// spaced/bounded).
//
// Fail-closed properties:
//   * rejections propagate unchanged after the slot is released;
//   * methods outside the intercepted set are passed through untouched;
//   * governance is a transport concern ONLY — results are neither
//     cached, altered, nor converted into negative evidence.

import type { Connection } from "@solana/web3.js";

import { governed, type RateGovernorOptions } from "./rpcTransport.js";
import type { EndpointKind } from "./provenance.js";

/**
 * The RPC surface used by the SDK activity derivation and the collect
 * path's identity fetch. Kept EXPLICIT (not a blanket interception) so a
 * future SDK method that appears here unlisted fails loud in review
 * rather than silently governed/ungoverned — governance coverage is a
 * documented property, not an accident.
 */
const GOVERNED_RPC_METHODS = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getParsedAccountInfo",
  "getTokenAccountBalance",
  "getTokenSupply",
  "getSignaturesForAddress",
  "getTransaction",
  "getParsedTransaction",
  "getBlock",
  "getSlot",
  "getEpochInfo",
]);

/**
 * Wrap `connection` so the intercepted RPC methods are issued under the
 * process-global rate governor for `endpointKind`. Test seams (faked
 * connections) are supported: the wrapper only intercepts the listed
 * methods and forwards every call verbatim.
 *
 * Injectable `now`/`sleep` exist ONLY for deterministic tests of the
 * wrapper itself; production callers never pass them.
 */
export function governedConnection(
  connection: Connection,
  endpointKind: EndpointKind,
  opts?: RateGovernorOptions & {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Connection {
  const { now, sleep, ...governorOpts } = opts ?? {};
  return new Proxy(connection, {
    get(target, prop, _receiver) {
      if (typeof prop === "string" && GOVERNED_RPC_METHODS.has(prop)) {
        const original = Reflect.get(target, prop, target) as unknown;
        if (typeof original !== "function") return original;
        return (...args: unknown[]) =>
          governed<unknown>(
            endpointKind,
            async () => (original as (...a: unknown[]) => unknown).apply(target, args),
            Object.keys(governorOpts).length > 0 ? governorOpts : undefined,
            now,
            sleep,
          );
      }
      return Reflect.get(target, prop, target);
    },
  }) as Connection;
}
