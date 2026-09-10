import * as THREE from 'three';
import { buildShip, buildAsteroid } from '../src/models.ts';
import catalog from './data/catalog.json';

// Design fixture only: no sockets, writes to campaign storage or gameplay authority.
const $ = selector => document.querySelector(selector);
const stage = $('#stage');
let view = 'flight', partIndex = 0, rosterPage = 0, ready = false, reconnecting = false, scanComplete = false;
let toastTimer;
document.querySelectorAll('button').forEach(button => { button.disabled = true; });
const weapons = ['gun-autocannon', 'gun-rail', 'gun-cutter'].map(id => catalog.parts.find(p => p.id === id));
const roles = [
  'A forgiving ballistic stream. Reliable escort fire, with room left for utility systems.',
  'A charged kinetic lance. Heavy recoil and precise fire demand a deliberate firing window.',
  'A close-range industrial beam. Cut salvage free or deny an enemy a clean approach.',
];
const effects = [
  'Balanced fit. Your radiator can dissipate sustained cannon heat.',
  'Tradeoff: slower acceleration; the 8 MJ capacitor supports one charged shot before recharge.',
  'Tradeoff: no ammunition, but sustained cutting exceeds passive cooling.',
];
const people = [
  ['VM', 'Venk', 'You / Kestrel', 'Fitting'], ['IA', 'Iona', 'Captain / Mule', 'Ready'],
  ['JN', 'Juno', 'Needle / Survey', 'Ready'], ['SO', 'Sol', 'Kestrel / Support', 'Ready'],
  ['—', 'Open seat', 'Browser guest', 'Available'], ['—', 'Open seat', 'Browser guest', 'Available'],
  ['—', 'Open seat', 'Browser guest', 'Available'], ['—', 'Open seat', 'Browser guest', 'Available'],
];
function toast(message) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 2600);
}
function renderRoster() {
  const perPage = stage.clientHeight < 600 ? 2 : 4;
  const pages = Math.ceil(people.length / perPage);
  rosterPage = Math.min(rosterPage, pages - 1);
  $('#roster').replaceChildren();
  people.slice(rosterPage * perPage, rosterPage * perPage + perPage).forEach((person, i) => {
    const row = document.createElement('div'); row.className = 'crew-row';
    const badge = document.createElement('span'); badge.className = 'crew-emblem'; badge.textContent = person[0];
    const name = document.createElement('div'); name.className = 'crew-name'; name.textContent = person[1];
    const role = document.createElement('small'); role.textContent = person[2]; name.append(role);
    const status = document.createElement('span'); status.className = 'crew-status';
    status.textContent = i === 0 && rosterPage === 0 ? ready ? 'Ready' : 'Fitting' : person[3];
    if (status.textContent === 'Fitting') status.classList.add('wait');
    row.append(badge, name, status); $('#roster').append(row);
  });
  $('#roster-page-label').textContent = `${rosterPage + 1} / ${pages}`;
  $('#crew-prev').disabled = rosterPage === 0; $('#crew-next').disabled = rosterPage === pages - 1;
}
function renderPart() {
  const part = weapons[partIndex];
  $('#part-name').textContent = part.name; $('#part-role').textContent = roles[partIndex];
  $('#part-page').textContent = `${partIndex + 1} / 3`; $('#fit-effect').textContent = effects[partIndex];
  $('#fit').textContent = `Fit ${part.name}`;
  const base = catalog.referenceFits.find(f => f.id === 'escort');
  const ids = base.parts.map(id => id === 'gun-autocannon' ? part.id : id);
  const parts = ids.map(id => catalog.parts.find(p => p.id === id));
  const hull = catalog.chassis.find(c => c.id === base.chassisId);
  const wetMass = hull.dryMassKg + hull.fuelKg + parts.reduce((sum, p) => sum + p.massKg, 0);
  const cost = hull.cost + parts.reduce((sum, p) => sum + p.cost, 0);
  const values = [['Module mass', `${(part.massKg / 1000).toFixed(1)} t`], ['Fit budget', `${cost} / 110`],
    ['Acceleration', `${(1600000 / wetMass).toFixed(1)} m/s²`], ['Shot / draw', part.energyShotMJ ? `${part.energyShotMJ} MJ` : `${part.activeMW} MW`]];
  $('#part-stats').replaceChildren(...values.map(([label, value]) => {
    const pair = document.createElement('div'); const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = label; dd.textContent = value; pair.append(dt, dd); return pair;
  }));
  railAttachment.visible = partIndex === 1;
  cutterAttachment.visible = partIndex === 2;
  $('#fit-status').textContent = 'Preview changes before committing your fit.';
}
function setView(next) {
  view = next; stage.dataset.view = next;
  document.querySelectorAll('.screen').forEach(screen => { screen.hidden = screen.id !== next; });
  document.querySelectorAll('[data-screen]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.screen === next)));
  $('#toast').hidden = true; layoutScene();
}
document.querySelectorAll('[data-screen]').forEach(button => button.addEventListener('click', () => setView(button.dataset.screen)));
$('#link-state').addEventListener('click', () => {
  reconnecting = !reconnecting; $('#link-state').textContent = `Link: ${reconnecting ? 'retrying' : 'online'}`;
  $('#link-state').setAttribute('aria-pressed', String(reconnecting)); $('#notice').hidden = !reconnecting;
  $('#scan').disabled = reconnecting || scanComplete; $('#ready').disabled = reconnecting; $('#fit').disabled = reconnecting;
  if (view !== 'flight') toast(reconnecting ? 'Connection fixture: waiting for host. Controls unavailable.' : 'Connection fixture restored.');
});
$('#crew-prev').addEventListener('click', () => { rosterPage = Math.max(0, rosterPage - 1); renderRoster(); });
$('#crew-next').addEventListener('click', () => { rosterPage++; renderRoster(); });
document.querySelectorAll('[data-lobby-pane]').forEach(button => button.addEventListener('click', () => {
  $('.lobby-layout').dataset.pane = button.dataset.lobbyPane;
  document.querySelectorAll('[data-lobby-pane]').forEach(tab => tab.setAttribute('aria-pressed', String(tab === button)));
}));
$('#ready').addEventListener('click', () => {
  ready = !ready; $('#ready').textContent = ready ? 'Cancel ready' : 'Ready up';
  $('#ready').setAttribute('aria-pressed', String(ready));
  $('#ready-status').textContent = ready ? 'Ready. Waiting for Iona to deploy the crew.' : 'Your fit is cleared for deployment.'; renderRoster();
});
$('#copy-address').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText('http://192.168.1.24:8080'); toast('Sample address copied. This fixture does not host a lobby.'); }
  catch { const range = document.createRange(); range.selectNodeContents($('.lobby-address')); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); toast('Select and copy the sample address.'); }
});
$('#part-prev').addEventListener('click', () => { partIndex = (partIndex + 2) % 3; renderPart(); });
$('#part-next').addEventListener('click', () => { partIndex = (partIndex + 1) % 3; renderPart(); });
$('#fit').addEventListener('click', () => {
  ready = false; $('#ready').textContent = 'Ready up'; $('#ready').setAttribute('aria-pressed', 'false'); renderRoster();
  $('#ready-status').textContent = 'Your fit changed. Ready up again when prepared.';
  $('#fit-status').textContent = `${weapons[partIndex].name} fitted in this preview. Ready status cleared.`;
});
$('#scan').addEventListener('click', () => {
  scanComplete = true;
  $('#objective').replaceChildren(document.createTextNode('Relay translated. Return to Vesper.'));
  $('#scan').textContent = 'Scan complete'; $('#scan').disabled = true;
  toast('Fixture objective complete. The signal is a maintenance request.');
});

await document.fonts.ready;
const renderer = new THREE.WebGLRenderer({ canvas: $('#space'), antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); renderer.setClearColor('#050b12');
renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.2;
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight('#9fc4db', '#17202c', 1.15));
const sun = new THREE.DirectionalLight('#fff0d8', 4.2); sun.position.set(-200, 240, 350); scene.add(sun);
const rim = new THREE.DirectionalLight('#68a5ce', 1.5); rim.position.set(200, -80, 120); scene.add(rim);
const camera = new THREE.OrthographicCamera(-400, 400, 250, -250, 1, 2000); camera.position.set(0, -150, 900); camera.lookAt(0, 0, 0);
const ship = buildShip('kestrel').group; scene.add(ship);
const gunMetal = new THREE.MeshStandardMaterial({ color: '#a1b4ba', roughness: .32, metalness: .85 });
const railAttachment = new THREE.Group();
for (const side of [-1, 1]) {
  const rail = new THREE.Mesh(new THREE.BoxGeometry(2, 47, 3), gunMetal); rail.position.set(side * 3, 34, 20); railAttachment.add(rail);
}
ship.add(railAttachment);
const cutterAttachment = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 10, 8), new THREE.MeshStandardMaterial({ color: '#d6b379', metalness: .5, roughness: .5 }));
cutterAttachment.position.set(0, 30, 20); ship.add(cutterAttachment);
const scenery = new THREE.Group(); scene.add(scenery);
const rocks = [[-280, 120, 42], [245, 135, 55], [300, -140, 28], [-190, -180, 24], [70, 200, 21], [-340, -40, 65], [140, -130, 15], [350, 250, 36], [-40, 255, 13]];
rocks.forEach(([x, y, radius], i) => { const rock = buildAsteroid(radius, i * 718 + 41); rock.position.set(x, y, -30 - i * 4); scenery.add(rock); });
const relay = new THREE.Group(); scenery.add(relay);
const ceramic = new THREE.MeshStandardMaterial({ color: '#a9b7b2', roughness: .68, metalness: .32 });
const basalt = new THREE.MeshStandardMaterial({ color: '#263740', roughness: .85, metalness: .18 });
const filament = new THREE.MeshBasicMaterial({ color: '#83cbd3' });
for (let ring = 0; ring < 3; ring++) {
  const radius = 46 + ring * 34;
  for (let n = 0; n < 20; n++) {
    if ((n + ring * 4) % 10 > 6) continue;
    const arc = new THREE.Mesh(new THREE.TorusGeometry(radius, 4 + ring, 6, 5, .255), n % 3 ? ceramic : basalt);
    arc.rotation.z = n * Math.PI / 10 + ring * .6; arc.position.set(ring * 6, ring * -4, 0); relay.add(arc);
    const thread = new THREE.Mesh(new THREE.TorusGeometry(radius, .45, 4, 5, .24), filament);
    thread.rotation.z = arc.rotation.z; thread.position.copy(arc.position); thread.position.z = 5 + ring; relay.add(thread);
  }
}
const core = new THREE.Mesh(new THREE.DodecahedronGeometry(18, 0), basalt); relay.add(core);
relay.position.set(-150, 75, -25); relay.rotation.set(.18, .28, -.25);
const points = new Float32Array(600 * 3); let seed = 3819;
function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }
for (let i = 0; i < points.length; i += 3) { points[i] = (random() - .5) * 2400; points[i + 1] = (random() - .5) * 1500; points[i + 2] = -200 - random() * 600; }
const stars = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(points, 3)), new THREE.PointsMaterial({ color: '#a3b8cb', size: 1.1, transparent: true, opacity: .65 })); scene.add(stars);
function layoutScene() {
  const width = stage.clientWidth, height = stage.clientHeight, aspect = width / height;
  renderRoster();
  renderer.setSize(width, height, false); camera.left = -250 * aspect; camera.right = 250 * aspect; camera.updateProjectionMatrix();
  scenery.visible = view !== 'hangar';
  const portrait = width <= 600 && height > 400;
  if (view === 'hangar') {
    ship.scale.setScalar(portrait ? .8 : 2.5); ship.position.set(portrait ? 0 : camera.left * .48, portrait ? 170 : 10, 0);
    ship.rotation.set(.25, -.35, -.5);
  } else {
    ship.scale.setScalar(view === 'lobby' ? 1.8 : .85); ship.position.set(portrait ? 40 : 65, view === 'lobby' ? 0 : -30, 0); ship.rotation.set(.15, -.15, -.55);
    relay.position.x = portrait ? -50 : -150; relay.scale.setScalar(portrait ? .7 : 1);
  }
  renderer.render(scene, camera);
}
const observer = new ResizeObserver(layoutScene); observer.observe(stage);
let frame = 0;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
function draw(time) { if (!reduced.matches && !document.hidden) core.rotation.z = time * .000025; renderer.render(scene, camera); frame = requestAnimationFrame(draw); }
window.addEventListener('pagehide', () => { cancelAnimationFrame(frame); observer.disconnect(); renderer.dispose(); }, { once: true });
document.querySelectorAll('button').forEach(button => { button.disabled = false; });
renderRoster(); renderPart(); layoutScene(); frame = requestAnimationFrame(draw);
window.__DRIFT_DESIGN__ = { ready: true, get view() { return view; }, get weapon() { return weapons[partIndex].id; } };
