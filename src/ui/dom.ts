/**
 * Markup builders for the shell (Plan A2/A6). Screens return HTML strings rather than DOM nodes:
 * a screen can then be asserted structurally in a plain Bun test with no browser, and the shell
 * owns exactly one place where strings become nodes. Nothing here reads layout.
 *
 * Every interactive control carries `data-action`. The shell binds one delegated listener and
 * `parseActions` lets tests prove that each rendered control resolves to a real transition.
 */

export type AttrValue = string | number | boolean | null | undefined;

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Player-supplied text reaches the DOM only through here (Plan A0: names must stay text). */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ESCAPES[character]!);
}

export function attrs(map: Readonly<Record<string, AttrValue>>): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(map)) {
    if (value === null || value === undefined || value === false) continue;
    parts.push(value === true ? ` ${name}` : ` ${name}="${esc(value)}"`);
  }
  return parts.join('');
}

export function el(tagName: string, map: Readonly<Record<string, AttrValue>> = {}, children: string | readonly string[] = ''): string {
  const body = Array.isArray(children) ? children.join('') : children;
  return `<${tagName}${attrs(map)}>${body}</${tagName}>`;
}

export type CtaKind = 'primary' | 'ghost' | 'danger' | 'tab';

export interface CtaOptions {
  readonly kind?: CtaKind;
  readonly disabled?: boolean;
  /** Exact blocker text copied onto the control so the reason is never hidden (Plan A2). */
  readonly reason?: string | null;
  readonly pressed?: boolean;
  readonly label2?: string;
  readonly hint?: string | null;
  /** Action payload, rendered as `data-<key>` and read back by the delegated listener. */
  readonly data?: Readonly<Record<string, string | number | null>>;
}

/**
 * One control shape for keyboard, touch and pointer: minimum 44 px hit area comes from `.cta` in
 * the stylesheet, and `aria-disabled` keeps a blocked action readable instead of invisible.
 */
export function cta(action: string, label: string, options: CtaOptions = {}): string {
  const disabled = options.disabled === true;
  const detail = options.reason ?? null;
  const hint = options.hint ?? null;
  const payload: Record<string, AttrValue> = {};
  for (const [key, value] of Object.entries(options.data ?? {})) payload[`data-${key}`] = value;
  return el(
    'button',
    {
      type: 'button',
      class: `cta ${options.kind ?? ''}`.trim(),
      'data-action': action,
      'aria-disabled': disabled ? 'true' : null,
      disabled: disabled,
      'aria-pressed': options.pressed === undefined ? null : String(options.pressed),
      title: detail ?? hint,
      'data-blocker': detail,
      ...payload,
    },
    `${esc(label)}${detail ? el('small', { class: 'cta-reason' }, esc(detail)) : ''}`,
  );
}

export function field(
  id: string,
  value: string,
  options: { label: string; placeholder?: string; type?: string; maxLength?: number; key?: string; describedBy?: string; disabled?: boolean } = { label: id },
): string {
  const describedBy = options.describedBy ?? null;
  const input = el('input', {
    type: options.type ?? 'text',
    id,
    name: id,
    value,
    placeholder: options.placeholder ?? null,
    maxlength: options.maxLength ?? null,
    'data-field': id,
    'data-key': options.key ?? null,
    'aria-describedby': describedBy,
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    disabled: options.disabled === true,
  });
  return el('label', { class: 'field', for: id }, [el('span', { class: 'field-label' }, esc(options.label)), input]);
}

export function group(label: string, body: string, options: { class?: string; id?: string } = {}): string {
  return el('section', { class: `group ${options.class ?? ''}`.trim(), id: options.id, 'aria-label': label }, body);
}

/** A labelled reading: label, value, optional detail. Never computes the value. */
export function reading(label: string, value: string, detail = ''): string {
  return el('div', { class: 'reading' }, [
    el('span', { class: 'reading-label' }, esc(label)),
    el('strong', { class: 'reading-value num' }, esc(value)),
    detail ? el('small', { class: 'reading-detail' }, esc(detail)) : '',
  ]);
}

/** Horizontal meter; the fill is a CSS variable so no screen writes inline layout numbers. */
export function meter(label: string, fraction: number, tone: 'signal' | 'caution' | 'threat' = 'signal'): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return el('div', { class: `meter tone-${tone}`, role: 'meter', 'aria-label': label, 'aria-valuenow': String(Math.round(clamped * 100)), style: `--fill:${(clamped * 100).toFixed(1)}%` }, [
    el('span', { class: 'meter-label' }, esc(label)),
  ]);
}

export function notice(text: string, kind: 'info' | 'error' | 'success' = 'info'): string {
  return el('p', { class: `notice tone-${kind}`, role: 'status', 'data-notice': kind }, esc(text));
}

export function tab(action: string, label: string, selected: boolean): string {
  return cta(action, label, { kind: 'tab', pressed: selected });
}

/** Every control the shell must be able to resolve; order-preserving and duplicate-free. */
export function parseActions(markup: string): readonly string[] {
  const found = new Set<string>();
  for (const match of markup.matchAll(/data-action="([^"]+)"/g)) found.add(match[1]!);
  return [...found];
}

/** Field ids present in markup, for draft reconciliation tests. */
export function parseFields(markup: string): readonly string[] {
  const found = new Set<string>();
  for (const match of markup.matchAll(/data-field="([^"]+)"/g)) found.add(match[1]!);
  return [...found];
}
