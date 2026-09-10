/**
 * Default flight bindings and conflict-free remap validation (Plan A3).
 *
 * Codes are `KeyboardEvent.code` values, not characters, so a remapped control keeps working on a
 * layout whose letters move. `Tab` and `Escape` stay reserved for menu navigation and closing one
 * layer; a remap can therefore never trap the pilot in a screen. Turn/strafe signs match the legacy
 * flight loop (`A` positive turn, `E` positive strafe) so both paths agree on the same intent.
 */

/** Every remappable control. `scoreboard` is a hold key: it ignores key repeat and closes on release. */
export const ACTION_IDS = [
  'thrust', 'reverse', 'turnLeft', 'turnRight', 'strafeLeft', 'strafeRight',
  'brake', 'boost', 'firePrimary', 'fireSecondary', 'interact', 'reload',
  'map', 'cinematic', 'help', 'pause', 'scoreboard',
] as const;

export type ActionId = (typeof ACTION_IDS)[number];

export type ActionKind = 'axis' | 'hold' | 'edge';

export interface ActionSpec {
  readonly id: ActionId;
  readonly label: string;
  /** axis feeds thrust/turn/strafe, hold is a boolean in the intent, edge fires once per press. */
  readonly kind: ActionKind;
  readonly hint: string;
}

export const ACTION_SPECS: readonly ActionSpec[] = [
  { id: 'thrust', label: 'Thrust forward', kind: 'axis', hint: 'W' },
  { id: 'reverse', label: 'Thrust reverse', kind: 'axis', hint: 'S' },
  { id: 'turnLeft', label: 'Turn left', kind: 'axis', hint: 'A' },
  { id: 'turnRight', label: 'Turn right', kind: 'axis', hint: 'D' },
  { id: 'strafeLeft', label: 'Strafe left', kind: 'axis', hint: 'Q' },
  { id: 'strafeRight', label: 'Strafe right', kind: 'axis', hint: 'E' },
  { id: 'brake', label: 'Brake', kind: 'hold', hint: 'X' },
  { id: 'boost', label: 'Boost', kind: 'hold', hint: 'Shift' },
  { id: 'firePrimary', label: 'Fire primary group', kind: 'hold', hint: 'Space' },
  { id: 'fireSecondary', label: 'Fire secondary group', kind: 'hold', hint: 'C' },
  { id: 'interact', label: 'Interact / assist', kind: 'edge', hint: 'F' },
  { id: 'reload', label: 'Reload', kind: 'edge', hint: 'R' },
  { id: 'map', label: 'Map', kind: 'edge', hint: 'M' },
  { id: 'cinematic', label: 'Cinematic camera', kind: 'edge', hint: 'V' },
  { id: 'help', label: 'Help', kind: 'edge', hint: 'H' },
  { id: 'pause', label: 'Pause / menu', kind: 'edge', hint: 'P' },
  { id: 'scoreboard', label: 'Scoreboard (hold)', kind: 'hold', hint: 'G' },
];

export const ACTION_LABELS: Readonly<Record<ActionId, string>> = Object.fromEntries(
  ACTION_SPECS.map((spec) => [spec.id, spec.label]),
) as Readonly<Record<ActionId, string>>;

export const ACTION_KINDS: Readonly<Record<ActionId, ActionKind>> = Object.fromEntries(
  ACTION_SPECS.map((spec) => [spec.id, spec.kind]),
) as Readonly<Record<ActionId, ActionKind>>;

/** Fire group bit for each fire action in `FlightIntent.fireMask`. */
export const FIRE_BITS: Readonly<Record<'firePrimary' | 'fireSecondary', number>> = {
  firePrimary: 1 << 0,
  fireSecondary: 1 << 1,
};

/** Never assignable: browser/menu navigation must survive any remap. */
export const RESERVED_CODES: Readonly<Record<string, true>> = { Tab: true, Escape: true };

export type Bindings = Readonly<Record<ActionId, readonly string[]>>;

export type BindingInput = Partial<Record<ActionId, readonly string[]>>;

export const DEFAULT_BINDINGS: Bindings = Object.freeze({
  thrust: ['KeyW'],
  reverse: ['KeyS'],
  turnLeft: ['KeyA'],
  turnRight: ['KeyD'],
  strafeLeft: ['KeyQ'],
  strafeRight: ['KeyE'],
  brake: ['KeyX'],
  boost: ['ShiftLeft', 'ShiftRight'],
  firePrimary: ['Space'],
  fireSecondary: ['KeyC'],
  interact: ['KeyF'],
  reload: ['KeyR'],
  map: ['KeyM'],
  cinematic: ['KeyV'],
  help: ['KeyH'],
  pause: ['KeyP'],
  scoreboard: ['KeyG'],
}) as Bindings;

/** One code claimed twice, or claimed at all when reserved. */
export interface BindingConflict {
  readonly code: string;
  readonly kind: 'duplicate' | 'reserved';
  readonly actions: readonly ActionId[];
}

export class BindingError extends Error {
  readonly conflicts: readonly BindingConflict[];
  constructor(message: string, conflicts: readonly BindingConflict[]) {
    super(message);
    this.name = 'BindingError';
    this.conflicts = conflicts;
  }
}

export function defaultBindings(): Bindings {
  return Object.fromEntries(
    ACTION_IDS.map((id) => [id, [...DEFAULT_BINDINGS[id]]]),
  ) as unknown as Bindings;
}

function cleanCodes(codes: unknown): string[] {
  if (!Array.isArray(codes)) return [];
  const out: string[] = [];
  for (const code of codes) {
    if (typeof code !== 'string' || code.length === 0 || code.length > 32) continue;
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

/** Duplicate and reserved-code conflicts in a candidate binding set. */
export function bindingConflicts(bindings: BindingInput): BindingConflict[] {
  const owners = new Map<string, ActionId[]>();
  for (const id of ACTION_IDS) {
    for (const code of cleanCodes(bindings[id])) {
      const list = owners.get(code) ?? [];
      list.push(id);
      owners.set(code, list);
    }
  }
  const conflicts: BindingConflict[] = [];
  for (const [code, actions] of owners) {
    if (code in RESERVED_CODES) conflicts.push({ code, kind: 'reserved', actions });
    else if (actions.length > 1) conflicts.push({ code, kind: 'duplicate', actions });
  }
  return conflicts;
}

/** Normalize, then refuse anything ambiguous. The Controls page calls this before saving a remap. */
export function validateBindings(bindings: BindingInput): Bindings {
  const normalized: Record<string, readonly string[]> = {};
  for (const id of ACTION_IDS) normalized[id] = Object.freeze(cleanCodes(bindings[id]));
  const conflicts = bindingConflicts(normalized);
  if (conflicts.length > 0) {
    const listed = conflicts.map((c) => `${c.code} (${c.actions.join(', ')})`).join('; ');
    throw new BindingError(`binding conflict: ${listed}`, conflicts);
  }
  return Object.freeze(normalized) as Bindings;
}

/** Assigning a code that another action owns is rejected instead of silently stealing it. */
export function assignBinding(bindings: Bindings, action: ActionId, code: string): Bindings {
  if (code in RESERVED_CODES) {
    throw new BindingError(`${code} is reserved for menu navigation`, [{ code, kind: 'reserved', actions: [action] }]);
  }
  const owner = ACTION_IDS.find((id) => id !== action && bindings[id].includes(code));
  if (owner) {
    throw new BindingError(`${code} already bound to ${owner}`, [{ code, kind: 'duplicate', actions: [owner, action] }]);
  }
  if (bindings[action].includes(code)) return bindings;
  return validateBindings({ ...bindings, [action]: [...bindings[action], code] });
}

export function removeBinding(bindings: Bindings, action: ActionId, code: string): Bindings {
  return validateBindings({ ...bindings, [action]: bindings[action].filter((c) => c !== code) });
}

/**
 * Repair an untrusted binding set for a migration. Explicit remaps are tried first; any remap
 * that collides with another action's binding (or with a reserved code) is reverted to its default,
 * so a corrupt file degrades to working controls instead of half-bound ones. Never throws.
 */
export function sanitizeBindings(raw: unknown): Bindings {
  const explicit = new Set<ActionId>();
  const candidate: Record<ActionId, string[]> = {} as Record<ActionId, string[]>;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const id of ACTION_IDS) {
      const value = (raw as Record<string, unknown>)[id];
      const codes = cleanCodes(value);
      if (codes.length > 0) {
        candidate[id] = codes;
        explicit.add(id);
      } else {
        candidate[id] = [...DEFAULT_BINDINGS[id]];
      }
    }
  } else {
    for (const id of ACTION_IDS) candidate[id] = [...DEFAULT_BINDINGS[id]];
  }

  // A contested code sends every explicit claimant back to its default; swaps that never collide
  // (thrust: KeyS, reverse: KeyT) survive because both sides are explicit.
  for (let pass = 0; pass <= ACTION_IDS.length; pass += 1) {
    const conflicts = bindingConflicts(candidate);
    if (conflicts.length === 0) break;
    let changed = false;
    for (const conflict of conflicts) {
      for (const action of conflict.actions) {
        if (!explicit.has(action)) continue;
        candidate[action] = [...DEFAULT_BINDINGS[action]];
        explicit.delete(action);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const accepted = new Set<string>();
  const out: Record<string, readonly string[]> = {};
  for (const id of ACTION_IDS) {
    const kept: string[] = [];
    for (const code of candidate[id]) {
      if (code in RESERVED_CODES || accepted.has(code)) continue;
      accepted.add(code);
      kept.push(code);
    }
    out[id] = Object.freeze(kept);
  }
  return Object.freeze(out) as Bindings;
}

const KEY_LABELS: Readonly<Record<string, string>> = {
  Space: 'Space',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  ControlLeft: 'Ctrl',
  ControlRight: 'Ctrl',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Enter',
  Backspace: 'Backspace',
};

/** Human label for the Controls page; unlisted codes render as their bare letter or name. */
export function keyLabel(code: string): string {
  const known = KEY_LABELS[code];
  if (known) return known;
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}
