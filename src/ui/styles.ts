/**
 * Shell stylesheet (Plan A3/A5). Kept as a string so the shell can install it itself: the UI owns
 * its layout, and no test or non-DOM renderer has to import CSS. Tokens match the reviewed design
 * handoff — space, instrument, ceramic, signal, caution, threat — and every control respects the
 * 44 px touch minimum, safe-area insets and the 100dvh viewport rule.
 */

export const UI_CSS = `
.drift-ui{--space:#050b12;--ink:#dfebe9;--muted:#9cafba;--signal:#83cbd3;--caution:#e8b56e;--threat:#ef8782;--panel:#122331;--line:#304651;
  color-scheme:dark;position:absolute;inset:0;z-index:1;background:var(--space);color:var(--ink);
  font:16px Barlow,system-ui,sans-serif;height:100dvh;overflow:hidden;
  padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
.drift-ui *{box-sizing:border-box;min-width:0}
.drift-ui .num{font-variant-numeric:tabular-nums}
.drift-ui h1,.drift-ui h2,.drift-ui h3{margin:0;font-family:"Barlow Condensed",Barlow,sans-serif;font-weight:500}
.drift-ui p,.drift-ui ul,.drift-ui ol,.drift-ui dl{margin:0}
.drift-ui ul,.drift-ui ol{padding:0;list-style:none}
.drift-ui svg{display:block}
.drift-ui .screen{position:absolute;inset:0;display:grid;grid-template-rows:auto minmax(0,1fr) auto;gap:12px;padding:16px;overflow:hidden}
.drift-ui .screen-copy,.drift-ui .hud-detail{color:var(--muted);font-size:14px}
.drift-ui .kicker,.drift-ui .hud-kicker{color:var(--muted);font-size:12px;letter-spacing:.02em}
.drift-ui .cta{font:inherit;color:inherit;background:#152a36;border:1px solid #43606b;border-radius:4px;
  padding:10px 16px;min-height:44px;min-width:44px;cursor:pointer;white-space:nowrap;display:inline-flex;
  align-items:center;gap:8px;justify-content:center}
.drift-ui .cta:hover{background:#24434d}
.drift-ui .cta:focus-visible{outline:3px solid var(--caution);outline-offset:3px}
.drift-ui .cta[disabled],.drift-ui .cta[aria-disabled=true]{opacity:.5;cursor:not-allowed}
.drift-ui .cta.primary{background:var(--signal);border-color:var(--signal);color:var(--space);font-weight:600}
.drift-ui .cta.danger{border-color:var(--threat);color:var(--threat)}
.drift-ui .cta.tab[aria-pressed=true]{background:#24434d;color:var(--signal)}
.drift-ui .cta-reason{display:block;font-size:12px;color:var(--caution);white-space:normal}
.drift-ui .notice{padding:8px 10px;border-left:3px solid var(--line);background:#0d1a24;font-size:14px}
.drift-ui .notice.tone-error{border-color:var(--threat);color:var(--threat)}
.drift-ui .notice.tone-success{border-color:var(--signal);color:var(--signal)}
.drift-ui .tone-threat{color:var(--threat)}
.drift-ui .tone-caution{color:var(--caution)}
.drift-ui .tone-signal{color:var(--signal)}
.drift-ui .tag{border:1px solid var(--line);border-radius:3px;padding:1px 6px;font-size:12px;color:var(--muted)}
.drift-ui .tag-captain{border-color:var(--signal);color:var(--signal)}
.drift-ui .group{border-top:1px solid var(--line);padding-top:8px;display:grid;gap:6px}
.drift-ui .reading{display:flex;gap:8px;align-items:baseline;font-size:14px}
.drift-ui .reading-label{color:var(--muted);min-width:9ch}
.drift-ui .reading-value{font-size:16px}
.drift-ui .field{display:grid;gap:4px;font-size:14px}
.drift-ui .field input[type=text]{min-height:44px;font:inherit;padding:8px 10px;background:#0d1a24;border:1px solid #43606b;border-radius:4px;color:var(--ink)}
.drift-ui .field-hint{font-size:12px;color:var(--muted)}
.drift-ui .meter{height:8px;background:#0d1a24;border:1px solid var(--line);border-radius:2px;position:relative}
.drift-ui .meter::after{content:"";position:absolute;inset:1px auto 1px 1px;width:var(--fill,0%);background:var(--signal)}
.drift-ui .tone-caution .meter::after,.drift-ui .meter.tone-caution::after{background:var(--caution)}
.drift-ui .meter.tone-threat::after{background:var(--threat)}
.drift-ui .screen-heading{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.drift-ui .screen-heading h1{font-size:34px}
.drift-ui .host-row,.drift-ui .screen-actions,.drift-ui .menu-footer,.drift-ui .lobby-tabs,.drift-ui .settings-tabs,.drift-ui .help-tabs,.drift-ui .hangar-tabs{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.drift-ui .menu-footer{justify-content:space-between}
.drift-ui .pager{display:flex;gap:8px;align-items:center;justify-content:space-between}
.drift-ui .blockers{color:var(--caution);font-size:14px}
.drift-ui .ready-note{color:var(--signal);font-size:14px}

/* Title / boot */
.drift-ui .title,.drift-ui .boot{place-content:center;grid-template-rows:none;display:flex;flex-direction:column;gap:16px;max-width:640px;margin:0 auto}
.drift-ui .title h1{font-size:64px;letter-spacing:.06em}
.drift-ui .title-menu{display:grid;gap:8px}
.drift-ui .title-progress{color:var(--muted);font-size:14px}
.drift-ui .asset-list{display:grid;gap:4px;font-size:14px}
.drift-ui .asset{display:flex;justify-content:space-between;gap:12px}

/* Host */
.drift-ui .host-grid{display:grid;gap:12px;grid-template-columns:minmax(0,1fr) minmax(0,1fr);overflow:auto}
.drift-ui .host-share{display:flex;gap:12px;align-items:flex-start}
.drift-ui .qr{width:144px;height:144px;background:var(--ink)}
.drift-ui .host-address{font-family:"Barlow Condensed",monospace;font-size:22px}

/* Join */
.drift-ui .join-form{display:grid;gap:10px;max-width:420px}
.drift-ui .recent-hosts{display:grid;gap:6px}

/* Lobby */
/* Six children: heading, phone tabs, layout, blockers, pager, footer. The flexible track has to be
 * the scrolling layout, not whatever lands in row two — with the generic three-row template the
 * flexible row collapsed to zero on short viewports and took the tab strip with it, which put the
 * Fit tab (and therefore Ready) out of reach at 320x568. */
.drift-ui .screen.lobby{grid-template-rows:auto auto minmax(0,1fr) auto auto auto}
.drift-ui .lobby-layout{display:grid;gap:16px;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr);overflow:auto}
.drift-ui .roster{display:grid;gap:4px}
.drift-ui .seat{display:grid;grid-template-columns:2ch minmax(0,1fr) auto;gap:8px;align-items:center;min-height:48px;border-bottom:1px solid var(--line);padding:4px 0}
.drift-ui .seat-name{font-size:16px;background:none;border:0;color:var(--ink);text-align:left;padding:6px 0;min-height:44px;cursor:pointer}
.drift-ui .seat-name[aria-pressed=true]{color:var(--signal)}
.drift-ui .seat-meta{display:flex;flex-wrap:wrap;gap:4px;font-size:12px;color:var(--muted)}
.drift-ui .seat-actions{display:flex;gap:6px}
.drift-ui .seat-actions .cta{min-height:44px;padding:6px 10px}
.drift-ui .seat.presence-reconnecting{opacity:.8}
.drift-ui .seat.editor{grid-template-columns:2ch minmax(0,1fr)}
.drift-ui .seat-editor{display:flex;gap:6px;align-items:end}
.drift-ui .seat-editor .field input{min-width:10ch}
.drift-ui .mission-panel h2{font-size:30px}
.drift-ui .fit-panel{display:grid;gap:8px;align-content:start}
.drift-ui .fit-deltas{display:grid;gap:4px;font-size:14px}
.drift-ui .fit-deltas li{display:flex;gap:8px;justify-content:space-between}
.drift-ui .lobby-tabs{display:none}

/* Hangar */
.drift-ui .hangar-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;overflow:auto}
.drift-ui .hangar-ship{display:grid;gap:6px;align-content:start}
.drift-ui .part-list{display:grid;gap:8px}
.drift-ui .part{display:grid;gap:2px;border:1px solid var(--line);padding:6px 8px}
.drift-ui .part.selected{border-color:var(--signal)}
.drift-ui .part.invalid{border-color:var(--threat)}
.drift-ui .part-reason{font-size:12px}
.drift-ui .priority{display:grid;gap:4px}
.drift-ui .priority li{display:flex;gap:8px;align-items:center}
.drift-ui .ammo-roles{display:grid;gap:2px;font-size:14px}
.drift-ui .fit-errors{color:var(--threat);font-size:14px}

/* Settings */
.drift-ui .settings-tabs .cta,.drift-ui .help-tabs .cta{border-radius:999px}
.drift-ui .setting-slider,.drift-ui .setting-select{display:flex;gap:8px;align-items:center;font-size:14px}
.drift-ui .setting-slider input[type=range]{flex:1;min-height:44px}
.drift-ui .setting-slider input[type=number]{width:6ch;min-height:44px;background:#0d1a24;color:var(--ink);border:1px solid #43606b}
.drift-ui .binding-list{display:grid;gap:4px;font-size:14px}
.drift-ui .binding-list li{display:flex;gap:8px;align-items:center}
.drift-ui .lesson{display:grid;gap:6px;font-size:16px;max-width:56ch}

/* Debrief / loading */
.drift-ui .score-table{width:100%;border-collapse:collapse;font-size:14px}
.drift-ui .score-table th,.drift-ui .score-table td{text-align:left;padding:4px 6px;border-bottom:1px solid var(--line)}
.drift-ui .score-table tr.departed{opacity:.5}
.drift-ui .loading-seats{display:grid;gap:4px}
.drift-ui .change-list li{display:flex;justify-content:space-between;gap:12px}

/* Flight HUD */
.drift-ui .flight{display:block;padding:0}
.drift-ui .flight-life{position:absolute;top:8px;left:50%;transform:translateX(-50%);font-size:14px;color:var(--muted)}
.drift-ui .hud{position:absolute;inset:0;pointer-events:none}
.drift-ui .hud button{pointer-events:auto}
.drift-ui .hud-top{position:absolute;top:8px;left:8px;right:8px;display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.drift-ui .hud-crew,.drift-ui .hud-objective,.drift-ui .hud-link,.drift-ui .hud-instruments,.drift-ui .hud-weapons,.drift-ui .hud-radar{
  background:rgba(18,35,49,.82);border:1px solid var(--line);border-radius:4px;padding:6px 8px;display:grid;gap:2px;max-width:36ch}
.drift-ui .hud-objective{text-align:center}
.drift-ui .hud-link{justify-items:end;text-align:right}
.drift-ui .hud-quality{font-size:12px;color:var(--muted)}
.drift-ui .hud-notice{font-size:12px;color:var(--caution)}
.drift-ui .hud-bottom{position:absolute;left:8px;right:8px;bottom:8px;display:flex;justify-content:space-between;align-items:flex-end;gap:12px}
.drift-ui .hud-radar{width:160px}
.drift-ui .hud-radar[data-collapsed=true] .radar-scope,.drift-ui .hud-radar[data-collapsed=true] .hud-detail{display:none}
.drift-ui .radar-scope{position:relative;width:var(--radar,144px);height:var(--radar,144px);border:1px solid var(--line);border-radius:50%;
  background:radial-gradient(circle,rgba(131,203,211,.08),transparent 70%)}
.drift-ui .radar-contact{position:absolute;left:var(--x);top:var(--y);width:6px;height:6px;margin:-3px 0 0 -3px;background:currentColor;border-radius:50%}
.drift-ui .radar-contact[data-kind=hostile]{border-radius:1px;transform:rotate(45deg)}
.drift-ui .radar-contact[data-kind=unknown]{border-radius:1px}
.drift-ui .radar-range{position:absolute;bottom:2px;left:50%;transform:translateX(-50%);font-size:11px;color:var(--muted)}
.drift-ui .hud-instruments{gap:8px;max-width:52ch}
.drift-ui .hud-resources{display:grid;gap:2px}
.drift-ui .hud-weapons{gap:6px}
.drift-ui .hud-weapon{display:grid;gap:1px}
.drift-ui .hud-weapon.blocked{color:var(--caution)}
.drift-ui .hud-field{position:absolute;left:15%;top:20%;width:70%;height:60%;pointer-events:none}
.drift-ui .field-reticle{position:absolute;left:50%;top:50%;width:18px;height:18px;margin:-9px 0 0 -9px;border:1px solid var(--signal);border-radius:50%}
.drift-ui .field-cue{position:absolute;left:50%;top:50%;transform:rotate(var(--bearing)) translateY(-46%) rotate(calc(-1 * var(--bearing)));font-size:13px;color:var(--caution)}
.drift-ui .field-cue[data-cue=threat-arrow]{color:var(--threat)}
.drift-ui .field-boundary{position:absolute;left:50%;bottom:4%;transform:translateX(-50%);font-size:13px;color:var(--caution)}
.drift-ui .flight-actions{position:absolute;right:8px;top:50%;transform:translateY(-50%);display:grid;gap:6px;justify-items:end}
.drift-ui .flight-prompt{position:absolute;left:50%;bottom:22%;transform:translateX(-50%);display:grid;gap:4px;justify-items:center}
.drift-ui .touch-layer{position:absolute;inset:0;pointer-events:none}

/* Overlays */
.drift-ui .overlay-host{position:absolute;inset:0;pointer-events:none}
.drift-ui .overlay{position:absolute;inset:4%;background:rgba(5,11,18,.94);border:1px solid var(--line);border-radius:6px;
  padding:16px;display:grid;gap:12px;align-content:start;overflow:auto;pointer-events:auto}
.drift-ui .overlay.confirm{inset:auto;left:50%;top:40%;transform:translate(-50%,-50%);min-width:min(420px,92vw)}
.drift-ui .overlay-close{justify-self:end}

@media(max-width:800px){
  .drift-ui .lobby-layout,.drift-ui .host-grid,.drift-ui .hangar-layout{grid-template-columns:minmax(0,1fr)}
  .drift-ui .lobby-tabs{display:flex}
  .drift-ui .lobby-layout[data-pane=crew] .mission-panel,.drift-ui .lobby-layout[data-pane=crew] .fit-panel{display:none}
  .drift-ui .lobby-layout[data-pane=mission] .roster-panel,.drift-ui .lobby-layout[data-pane=mission] .fit-panel{display:none}
  .drift-ui .lobby-layout[data-pane=fit] .roster-panel,.drift-ui .lobby-layout[data-pane=fit] .mission-panel{display:none}
  .drift-ui .hud-bottom{gap:8px}
  .drift-ui .hud-instruments{max-width:40ch}
}
@media(max-height:560px){
  .drift-ui .screen{padding:10px;gap:8px}
  .drift-ui .hud-radar{width:120px}
  .drift-ui .radar-scope{--radar:104px}
  .drift-ui .title h1{font-size:44px}
}
@media(prefers-reduced-motion:reduce){.drift-ui *,.drift-ui *::before,.drift-ui *::after{animation:none!important;transition:none!important}}
`;

/** Install the stylesheet once per document; repeated shells reuse it. */
export function ensureStyles(doc: Document, id = 'drift-ui-styles'): void {
  if (doc.getElementById(id)) return;
  const style = doc.createElement('style');
  style.id = id;
  style.textContent = UI_CSS;
  doc.head.append(style);
}
