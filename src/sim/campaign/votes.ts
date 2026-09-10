/**
 * B8 vote rules. A vote snapshots the connected eligible humans when it opens, so a late join
 * spectates instead of changing the electorate, and a reconnect can still ballot before the
 * deadline because eligibility — not presence at the poll — is what the snapshot froze.
 *
 * Exactly one ballot per pilot, one commit per vote, and no captain override afterwards: after
 * `resolveVote` returns `committed`, every later ballot and every later resolve is a no-op.
 */

import { RULES } from '../../shared/balance.ts';
import type { CampaignView, Id } from '../../shared/contracts.ts';
import { CAMPAIGN_TICK_RATE } from './missions.ts';

export type VoteKind = 'decision' | 'recovery';

export interface VoteOption {
  id: Id;
  label: string;
}

export type VoteReason = 'majority' | 'default-tie' | 'default-no-votes' | 'already-committed' | 'open';

export interface VoteOutcome {
  optionId: Id;
  reason: Exclude<VoteReason, 'already-committed' | 'open'>;
  tally: Record<Id, number>;
}

export interface VoteState {
  id: Id;
  kind: VoteKind;
  options: readonly VoteOption[];
  /** Displayed conservative option used on a tie or when nobody votes. */
  defaultOptionId: Id;
  /** Connected eligible humans at open time; a pilot outside this list can only spectate. */
  eligiblePilotIds: readonly Id[];
  ballots: Map<Id, Id>;
  openedAtTick: number;
  endsAtTick: number;
  committed: boolean;
  outcome: VoteOutcome | null;
}

export type VoteCode = 'ok' | 'not-eligible' | 'closed' | 'already-voted' | 'unknown-option' | 'decided';

export interface VoteCast {
  ok: boolean;
  code: VoteCode;
}

export interface VoteResolution {
  committed: boolean;
  optionId: Id | null;
  reason: VoteReason;
}

export interface OpenVoteInput {
  id: Id;
  kind: VoteKind;
  options: readonly VoteOption[];
  defaultOptionId: Id;
  eligiblePilotIds: readonly Id[];
  tick: number;
  /** Defaults to the 30 s story window; the all-humans-destroyed vote passes 20 (B7). */
  seconds?: number;
}

export function openVote(input: OpenVoteInput): VoteState {
  if (!input.options.some(option => option.id === input.defaultOptionId)) {
    throw new RangeError(`vote ${input.id}: default option ${input.defaultOptionId} is not offered`);
  }
  const seconds = input.seconds ?? RULES.voteSeconds;
  return {
    id: input.id,
    kind: input.kind,
    options: input.options,
    defaultOptionId: input.defaultOptionId,
    eligiblePilotIds: [...input.eligiblePilotIds],
    ballots: new Map(),
    openedAtTick: input.tick,
    endsAtTick: input.tick + seconds * CAMPAIGN_TICK_RATE,
    committed: false,
    outcome: null,
  };
}

export function castVote(vote: VoteState, pilotId: Id, optionId: Id, tick: number): VoteCast {
  if (vote.committed) return { ok: false, code: 'decided' };
  if (tick >= vote.endsAtTick) return { ok: false, code: 'closed' };
  if (!vote.eligiblePilotIds.includes(pilotId)) return { ok: false, code: 'not-eligible' };
  if (!vote.options.some(option => option.id === optionId)) return { ok: false, code: 'unknown-option' };
  if (vote.ballots.has(pilotId)) return { ok: false, code: 'already-voted' };
  vote.ballots.set(pilotId, optionId);
  return { ok: true, code: 'ok' };
}

/** Resolve at or after the deadline. A second resolve reports the committed outcome unchanged. */
export function resolveVote(vote: VoteState, tick: number): VoteResolution {
  if (vote.outcome !== null) return { committed: false, optionId: vote.outcome.optionId, reason: 'already-committed' };
  if (tick < vote.endsAtTick) return { committed: false, optionId: null, reason: 'open' };

  const tally: Record<Id, number> = {};
  for (const option of vote.options) tally[option.id] = 0;
  let cast = 0;
  for (const optionId of vote.ballots.values()) {
    tally[optionId] = (tally[optionId] ?? 0) + 1;
    cast++;
  }

  let winner: Id | null = null;
  for (const option of vote.options) {
    // Strict majority of cast votes; a tie can never satisfy `> cast / 2` for two options.
    if (tally[option.id]! * 2 > cast) winner = option.id;
  }
  const reason: VoteOutcome['reason'] = cast === 0 ? 'default-no-votes' : winner === null ? 'default-tie' : 'majority';
  const optionId = winner ?? vote.defaultOptionId;
  vote.committed = true;
  vote.outcome = { optionId, reason, tally };
  return { committed: true, optionId, reason };
}

/** Snapshot for `CampaignView.activeVote`; null once the decision is committed. */
export function voteView(vote: VoteState): NonNullable<CampaignView['activeVote']> | null {
  if (vote.committed) return null;
  const votes: Record<Id, Id> = {};
  for (const [pilotId, optionId] of vote.ballots) votes[pilotId] = optionId;
  return {
    id: vote.id,
    options: vote.options.map(option => ({ id: option.id, label: option.label })),
    eligiblePilotIds: vote.eligiblePilotIds,
    votes,
    defaultOptionId: vote.defaultOptionId,
    endsAtTick: vote.endsAtTick,
  };
}
