/**
 * Operator authority (Plan B2). Administration belongs to the Windows process, not to the first
 * network arrival: the launcher opens a loopback URL carrying a random one-use claim in its
 * fragment, the browser consumes it over a loopback socket, and from then on only loopback
 * connections presenting the admin token may reclaim or stop the room.
 *
 * A `Host: localhost` header is not evidence of anything — both gates require the connection's
 * remote address to be loopback *and* an Origin from the served set. The claim token is never
 * logged and never leaves the fragment; only its one-use consumption is recorded here.
 */

import type { Id } from '../shared/contracts.ts';
import type { OperatorClaim } from '../shared/contracts.ts';
import { originAllowed } from '../shared/validate.ts';

/** ≥128 random bits, URL-safe; the launcher never prints it. */
export function randomSecret(bytes = 32): string {
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buffer].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Loopback includes the IPv4-mapped form a dual-stack listener reports. */
export function isLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.');
}

export type OperatorDenial = 'not-loopback' | 'bad-origin' | 'absent' | 'expired' | 'already-claimed' | 'bad-token';

export interface OperatorCheck {
  ok: boolean;
  denial?: OperatorDenial;
}

const ACCEPT: OperatorCheck = { ok: true };
const deny = (denial: OperatorDenial): OperatorCheck => ({ ok: false, denial });

export interface OperatorPeer {
  remoteAddress: string;
  origin: string | null;
}

export interface OperatorAuthorityOptions {
  /** Claim lifetime; short, because the launcher consumes it immediately. */
  claimTtlMs?: number;
  now?: () => number;
}

/**
 * One-use claim plus the loopback/admin gates. `consume` is the only way to become the operator,
 * and it succeeds exactly once even if two loopback connections race.
 */
export class OperatorAuthority {
  readonly adminToken: string;
  private currentClaim: OperatorClaim;
  private readonly now: () => number;
  private expiresAtMs: number;
  private readonly claimTtlMs: number;
  private claimed = false;

  constructor(options: OperatorAuthorityOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.claimTtlMs = options.claimTtlMs ?? 10 * 60 * 1000;
    this.expiresAtMs = this.now() + this.claimTtlMs;
    this.currentClaim = { token: randomSecret(), expiresAt: new Date(this.expiresAtMs).toISOString() };
    this.adminToken = randomSecret();
  }

  get claim(): OperatorClaim {
    return this.currentClaim;
  }

  /** Fresh one-use claim for an authenticated reclaim; only the admin route may call this. */
  issueClaim(): OperatorClaim {
    this.expiresAtMs = this.now() + this.claimTtlMs;
    this.currentClaim = { token: randomSecret(), expiresAt: new Date(this.expiresAtMs).toISOString() };
    return this.currentClaim;
  }

  get isClaimed(): boolean {
    return this.claimed;
  }

  get claimExpired(): boolean {
    return this.now() > this.expiresAtMs;
  }

  /** The operator loopback URL; the fragment is the only place the claim token appears. */
  operatorUrl(origin: string): string {
    return `${origin.replace(/\/$/, '')}/#op=${this.claim.token}`;
  }

  /** Remote loopback *and* an allowed Origin; either check alone is not enough. */
  check(peer: OperatorPeer, allowedOrigins: readonly string[]): OperatorCheck {
    if (!isLoopback(peer.remoteAddress)) return deny('not-loopback');
    if (!originAllowed(peer.origin, allowedOrigins)) return deny('bad-origin');
    return ACCEPT;
  }

  /** Consumes the claim. A second call — same token or not — is `already-claimed`. */
  consume(token: string, peer: OperatorPeer, allowedOrigins: readonly string[]): OperatorCheck {
    const gate = this.check(peer, allowedOrigins);
    if (!gate.ok) return gate;
    if (token.length === 0) return deny('absent');
    if (this.claimed) return deny('already-claimed');
    if (this.claimExpired) return deny('expired');
    if (!timingSafeEqual(token, this.claim.token)) return deny('bad-token');
    this.claimed = true;
    return ACCEPT;
  }

  /** Operator reclaim from a fresh authenticated loopback session; never a second claim. */
  reclaim(token: string, peer: OperatorPeer, allowedOrigins: readonly string[]): OperatorCheck {
    const gate = this.check(peer, allowedOrigins);
    if (!gate.ok) return gate;
    if (!timingSafeEqual(token, this.adminToken)) return deny('bad-token');
    return ACCEPT;
  }

  verifyAdmin(token: string): boolean {
    return timingSafeEqual(token, this.adminToken);
  }
}

/** Constant-time compare; the tokens are short and this is cheap. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

/** Stable room id used in the launch URL so a stale tab cannot claim a restarted host. */
export function launchRoomId(port: number, startedAtMs: number): Id {
  return `host-${port}-${Math.floor(startedAtMs / 1000).toString(36)}`;
}
