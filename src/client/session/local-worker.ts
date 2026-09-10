/**
 * Offline worker entry (Plan B9). This file is only ever loaded as a module worker: it installs the
 * message bridge and nothing else, so the authority room and the campaign store live off the main
 * thread and a stalled IndexedDB write cannot touch the render loop.
 *
 * The Vite/browser pattern `new Worker(new URL('./local-worker.ts', import.meta.url), { type:
 * 'module' })` in `local.ts` is the only caller; tests run the same worker through Bun.
 */

import { createLocalHost } from './local.ts';
import type { HostReply, HostRequest } from './local.ts';

const scope = globalThis as unknown as {
  postMessage: (reply: HostReply) => void;
  onmessage: ((event: { data: HostRequest }) => void) | null;
};

const host = createLocalHost(reply => scope.postMessage(reply));

scope.onmessage = event => {
  void host.request(event.data);
};
