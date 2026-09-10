/**
 * Address normalisation for the Join screen (Plan A2/B2). The pilot sees exactly which origin will
 * be dialled, and an unusable entry stays unusable instead of being rewritten to localhost.
 */

const DEFAULT_PORT = 8080;

/** Accepts `192.168.1.24`, `192.168.1.24:8080`, `http://host:8080/path` and returns `host:port`. */
export function normalizeAddress(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  // A bare scheme with no host is not an address, and bare localhost is never substituted.
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const authority = withoutScheme.split(/[/?#]/, 1)[0] ?? '';
  if (authority.length === 0) return null;
  const [hostPart, portPart] = authority.split(':');
  const host = (hostPart ?? '').trim();
  if (host.length === 0) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(host)) return null;
  const port = portPart === undefined || portPart === '' ? DEFAULT_PORT : Number(portPart);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `${host}:${port}`;
}

/** Recent hosts are stored as normalised strings; a newer entry replaces an older duplicate. */
export function rememberHost(recent: readonly string[], address: string, limit = 5): readonly string[] {
  const normalised = normalizeAddress(address);
  if (!normalised) return recent;
  return [normalised, ...recent.filter(host => host !== normalised)].slice(0, limit);
}
