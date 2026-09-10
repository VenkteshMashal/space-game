/**
 * Title screen (Plan A2). Resume states exactly where the campaign lives and when it was saved;
 * offline play, LAN join, the host guide and settings are separate destinations. The ship/sector
 * background is declared here and mounted by the render slice — this module never touches Three.
 */

import { cta, el } from '../dom.ts';

export interface TitleProps {
  readonly releaseLabel: string;
  readonly progress: string | null;
  readonly resume: {
    readonly owner: 'host' | 'device';
    readonly location: string;
    readonly savedAt: string | null;
  } | null;
  readonly offlineAvailable: boolean;
  readonly lanAvailable: boolean;
  readonly notice: string | null;
}

function resumeDetail(resume: TitleProps['resume']): string {
  if (!resume) return 'No campaign on this device.';
  const where = resume.owner === 'host' ? `host PC (${resume.location})` : `this device (${resume.location})`;
  return resume.savedAt ? `Saved on ${where} \u00b7 ${resume.savedAt}` : `Saved on ${where}`;
}

export function titleMarkup(props: TitleProps): string {
  return el('section', { class: 'screen title', 'data-screen': 'title', 'data-background': 'title' }, [
    el('header', { class: 'title-head' }, [
      el('h1', {}, 'DRIFT'),
      el('p', { class: 'screen-copy' }, props.releaseLabel),
    ]),
    el('nav', { class: 'title-menu', 'aria-label': 'Start' }, [
      cta('title.resume', 'Resume campaign', {
        kind: 'primary',
        disabled: props.resume === null,
        reason: props.resume ? null : 'No save on this device',
      }),
      el('p', { class: 'title-detail' }, resumeDetail(props.resume)),
      cta('title.offline', 'Play offline', { disabled: !props.offlineAvailable, reason: props.offlineAvailable ? null : 'Simulation did not load' }),
      cta('title.join', 'Join LAN', { disabled: !props.lanAvailable, reason: props.lanAvailable ? null : 'No network stack' }),
      cta('title.host', 'Host guide'),
      cta('title.settings', 'Settings'),
      cta('title.help', 'Controls and help'),
    ]),
    props.notice ? el('p', { class: 'notice tone-info', role: 'status' }, props.notice) : '',
    props.progress ? el('p', { class: 'title-progress num' }, props.progress) : '',
  ]);
}
