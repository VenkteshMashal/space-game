/**
 * Team identity shared by the authority, the score ledger and the HUD. Team colour is always paired
 * with a shape or pattern in the UI (Plan A5): colour alone is not an accessible distinction.
 */

import type { Id } from './contracts.ts';

export const TEAM_BLUE: Id = 'blue';
export const TEAM_RED: Id = 'red';
export const TEAM_CREW: Id = 'crew';
export const TEAM_HOSTILE: Id = 'cinder';

export interface TeamDefinition {
  id: Id;
  name: string;
  short: string;
  /** Shape token the UI draws next to any team colour. */
  shape: 'chevron' | 'wedge' | 'ring' | 'bar';
  token: string;
}

export const TEAMS: readonly TeamDefinition[] = [
  { id: TEAM_CREW, name: 'Wayfarer crew', short: 'Crew', shape: 'chevron', token: '--signal' },
  { id: TEAM_BLUE, name: 'Blue fleet', short: 'Blue', shape: 'chevron', token: '--signal' },
  { id: TEAM_RED, name: 'Red fleet', short: 'Red', shape: 'wedge', token: '--threat' },
  { id: TEAM_HOSTILE, name: 'Cinder raiders', short: 'Cinder', shape: 'wedge', token: '--threat' },
  { id: 'neutral', name: 'Unclaimed', short: 'Neutral', shape: 'ring', token: '--caution' },
];

export const PVP_TEAMS: readonly Id[] = [TEAM_BLUE, TEAM_RED];

export function teamById(teamId: Id): TeamDefinition | null {
  return TEAMS.find(team => team.id === teamId) ?? null;
}

export function opposingTeam(teamId: Id): Id | null {
  if (teamId === TEAM_BLUE) return TEAM_RED;
  if (teamId === TEAM_RED) return TEAM_BLUE;
  return null;
}

/** Friendly fire defaults off, but allies still block shots (B6). */
export function isFriendly(a: Id, b: Id): boolean {
  return a === b;
}
