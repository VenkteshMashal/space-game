import { SHIPS } from './physics';
import type { Loadout, ShipClass } from './physics';
import { LOADOUT_BUDGET, PALETTE } from './world';
import type { LobbyPlayer, TeamId } from './world';

const TEAM_LABEL: Record<TeamId, string> = { blue: 'Blue fleet', red: 'Red fleet', pirate: 'Pirates' };
const CHASSIS: ShipClass[] = ['kestrel', 'mule', 'needle'];
const POINT_KEYS = ['hullPts', 'thrustPts', 'fuelPts', 'torquePts'] as const;
const POINT_LABEL: Record<(typeof POINT_KEYS)[number], string> = {
  hullPts: 'Hull', thrustPts: 'Thrust', fuelPts: 'Propellant', torquePts: 'Agility',
};

export type LobbyEdit = { name?: string; team?: TeamId; loadout?: Loadout; ready?: boolean; mapId?: string };

export type LobbyModel = {
  you: string;
  isHost: boolean;
  hostUrl: string;
  mapId: string;
  players: LobbyPlayer[];
  local: { name: string; team: TeamId; loadout: Loadout; ready: boolean };
};

export type LobbyDeps = {
  open(html: string, wide?: boolean): void;
  onChange(edit: LobbyEdit): void;
  onStart(): void;
};

const pointsSpent = (loadout: Loadout) => POINT_KEYS.reduce((sum, key) => sum + loadout[key], 0);

function roster(model: LobbyModel) {
  if (!model.players.length) return '<p class="lobby-empty">No pilots yet. Others join at the address above.</p>';
  return model.players.map(player => `<div class="lobby-pilot${player.id === model.you ? ' is-you' : ''}">
    <span class="team-pill team-${player.team}">${TEAM_LABEL[player.team]}</span>
    <strong>${escapeHtml(player.name)}</strong>
    ${player.isHost ? '<span class="lobby-tag">host</span>' : ''}
    ${player.ready ? '<span class="lobby-tag ready">ready</span>' : '<span class="lobby-tag">waiting</span>'}
  </div>`).join('');
}

function loadoutPanel(model: LobbyModel) {
  const { loadout } = model.local;
  const spent = pointsSpent(loadout);
  return `<section class="lobby-loadout">
    <span class="section-label">Your ship</span>
    <label class="lobby-name">Pilot name<input id="lobby-name" type="text" maxlength="16" value="${escapeHtml(model.local.name)}"/></label>
    <div class="lobby-teams" role="group" aria-label="Team">${(['blue', 'red', 'pirate'] as TeamId[]).map(team =>
      `<button type="button" class="team-button team-${team}${model.local.team === team ? ' selected' : ''}" data-team="${team}" aria-pressed="${model.local.team === team}">${TEAM_LABEL[team]}</button>`).join('')}</div>
    <div class="lobby-chassis" role="radiogroup" aria-label="Chassis">${CHASSIS.map(chassis =>
      `<label class="chassis-option${loadout.chassis === chassis ? ' selected' : ''}"><input type="radio" name="chassis" value="${chassis}"${loadout.chassis === chassis ? ' checked' : ''}/><span>${SHIPS[chassis].name}</span><small>${SHIPS[chassis].role}</small></label>`).join('')}</div>
    <div class="lobby-points">
      ${POINT_KEYS.map(key => `<label class="point-slider"><span>${POINT_LABEL[key]}<b id="pts-${key}">${loadout[key]}</b></span>
        <input type="range" min="0" max="5" step="1" value="${loadout[key]}" data-points="${key}" aria-label="${POINT_LABEL[key]} points"/></label>`).join('')}
      <span class="points-counter">Points spent <b id="lobby-points-total">${spent}</b> / ${LOADOUT_BUDGET}</span>
    </div>
    <div class="lobby-colors" role="group" aria-label="Hull colour">${PALETTE.map(color =>
      `<button type="button" class="color-swatch${loadout.color === color ? ' selected' : ''}" data-color="${color}" style="--swatch:${color}" aria-label="Hull colour ${color}" aria-pressed="${loadout.color === color}"></button>`).join('')}</div>
  </section>`;
}

function mapPanel(model: LobbyModel) {
  if (!model.isHost) return '';
  return `<section class="lobby-maps">
    <span class="section-label">Arena</span>
    <div class="lobby-map-list">${MAP_CARDS.map(card =>
      `<button type="button" class="map-card${model.mapId === card.id ? ' selected' : ''}" data-map="${card.id}" aria-pressed="${model.mapId === card.id}"><strong>${card.name}</strong><small>${card.detail}</small></button>`).join('')}
    </div>
  </section>`;
}

const MAP_CARDS = [
  { id: 'belt', name: 'Drift Belt', detail: '110 rocks · 1.5 km' },
  { id: 'quarry', name: 'The Quarry', detail: '190 rocks · 1.1 km' },
  { id: 'expanse', name: 'Open Expanse', detail: '55 rocks · 2.2 km' },
];

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

export function lobbyMarkup(model: LobbyModel) {
  return `<div data-lobby>
    <span class="dialog-kicker">Local network flight</span>
    <h2 id="dialog-title">Bring a wing.</h2>
    <p class="dialog-description">Everyone on this network can join. Pick a team and a hull, then the host launches the match.</p>
    ${model.isHost ? `<div class="lobby-address"><span class="section-label">Join this address</span><span class="lobby-url">${model.hostUrl}</span><button type="button" class="secondary-button" id="lobby-copy">Copy</button></div>` : ''}
    <div class="lobby-grid">
      <section class="lobby-roster"><span class="section-label">Pilots</span>${roster(model)}</section>
      ${loadoutPanel(model)}
      ${mapPanel(model)}
    </div>
    <div class="lobby-actions">
      <button type="button" class="${model.local.ready ? 'secondary-button' : 'primary-button'}" id="lobby-ready" aria-pressed="${model.local.ready}">${model.local.ready ? 'Ready — waiting for the host' : 'Ready up'}</button>
      ${model.isHost ? `<button type="button" class="primary-button" id="lobby-start">Launch match ${'▶'}</button>` : ''}
    </div>
  </div>`;
}

export function showLobby(model: LobbyModel, deps: LobbyDeps) {
  deps.open(lobbyMarkup(model), true);
  wireLobby(model, deps);
}

/** True when the lobby dialog is the thing on screen; a shipyard or manual dialog is left alone. */
export const lobbyOpen = () => !!document.querySelector('#dialog-content [data-lobby]');

export function refreshLobby(model: LobbyModel, deps: LobbyDeps) {
  if (!lobbyOpen()) return;
  const content = document.querySelector('#dialog-content');
  if (!content) return;
  // Do not yank a control out from under the player's fingers mid-edit.
  if (document.activeElement?.matches('input[type="range"], input[type="text"]')) return;
  content.innerHTML = lobbyMarkup(model);
  wireLobby(model, deps);
}

function wireLobby(model: LobbyModel, deps: LobbyDeps) {
  const content = document.querySelector('#dialog-content')!;
  content.querySelector('#lobby-copy')?.addEventListener('click', () => {
    void navigator.clipboard?.writeText(model.hostUrl).then(
      () => { const button = content.querySelector('#lobby-copy'); if (button) button.textContent = 'Copied'; },
      () => { /* Clipboard is optional. */ },
    );
  });
  content.querySelector('#lobby-ready')?.addEventListener('click', () => deps.onChange({ ready: !model.local.ready }));
  content.querySelector('#lobby-start')?.addEventListener('click', () => deps.onStart());

  const name = content.querySelector<HTMLInputElement>('#lobby-name');
  name?.addEventListener('change', () => deps.onChange({ name: name.value }));

  content.querySelectorAll<HTMLButtonElement>('[data-team]').forEach(button =>
    button.addEventListener('click', () => deps.onChange({ team: button.dataset.team as TeamId })));
  content.querySelectorAll<HTMLButtonElement>('[data-color]').forEach(button =>
    button.addEventListener('click', () => deps.onChange({ loadout: { ...model.local.loadout, color: button.dataset.color! } })));
  content.querySelectorAll<HTMLButtonElement>('[data-map]').forEach(button =>
    button.addEventListener('click', () => deps.onChange({ mapId: button.dataset.map! })));
  content.querySelectorAll<HTMLInputElement>('input[name="chassis"]').forEach(input =>
    input.addEventListener('change', () => deps.onChange({ loadout: { ...model.local.loadout, chassis: input.value as ShipClass } })));

  const total = content.querySelector('#lobby-points-total');
  content.querySelectorAll<HTMLInputElement>('[data-points]').forEach(slider => {
    slider.addEventListener('input', () => {
      // Live counter only: the server is asked once the slider is released.
      const next = { ...model.local.loadout, [slider.dataset.points!]: Number(slider.value) };
      if (total) total.textContent = String(pointsSpent(next as Loadout));
      const own = content.querySelector(`#pts-${slider.dataset.points}`);
      if (own) own.textContent = slider.value;
    });
    slider.addEventListener('change', () => deps.onChange({ loadout: { ...model.local.loadout, [slider.dataset.points!]: Number(slider.value) } }));
  });
}
