import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

/** An external test pilot issues ordinary key events; it cannot mutate game state. */
export async function runMission(page) {
  const result = await page.evaluate(async () => {
    const { createObstacles, STATION } = await import('/src/physics.ts');
    const rocks = createObstacles().filter(r => r.z === 0);
    const pressed = new Set();
    const setKey = (code, down) => {
      if (pressed.has(code) === down) return;
      if (down) pressed.add(code); else pressed.delete(code);
      window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }));
    };
    const release = () => { for (const code of [...pressed]) setKey(code, false); };
    const tap = code => { setKey(code, true); setKey(code, false); };
    const len = (x, y) => Math.hypot(x, y);
    function clearLine(a, b) {
      const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
      return !rocks.some(r => {
        const t = d2 ? Math.max(0, Math.min(1, ((r.x - a.x) * dx + (r.y - a.y) * dy) / d2)) : 0;
        return len(r.x - a.x - dx * t, r.y - a.y - dy * t) < r.radius * 0.83 + 39;
      });
    }
    function plan(start, goal) {
      if (clearLine(start, goal)) return [goal];
      const size = 38;
      const encode = (x, y) => `${x},${y}`;
      const initial = { x: Math.round(start.x / size), y: Math.round(start.y / size) };
      const end = { x: Math.round(goal.x / size), y: Math.round(goal.y / size) };
      const open = [{ ...initial, score: 0 }], visited = new Set(), costs = new Map([[encode(initial.x, initial.y), 0]]), parents = new Map();
      let finalKey;
      for (let iteration = 0; iteration < 12000 && open.length; iteration++) {
        open.sort((a, b) => a.score - b.score);
        const current = open.shift(), key = encode(current.x, current.y);
        if (visited.has(key)) continue;
        visited.add(key);
        if (current.x === end.x && current.y === end.y) { finalKey = key; break; }
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue;
          const nx = current.x + dx, ny = current.y + dy, nextKey = encode(nx, ny);
          if (Math.abs(nx) > 45 || Math.abs(ny) > 38 || visited.has(nextKey)) continue;
          if (!clearLine({ x: current.x * size, y: current.y * size }, { x: nx * size, y: ny * size })) continue;
          const cost = costs.get(key) + Math.hypot(dx, dy);
          if (cost >= (costs.get(nextKey) ?? Infinity)) continue;
          costs.set(nextKey, cost); parents.set(nextKey, key);
          open.push({ x: nx, y: ny, score: cost + len(end.x - nx, end.y - ny) });
        }
      }
      if (!finalKey) throw new Error('Could not plan a collision-free recovery route');
      const path = [goal];
      while (parents.has(finalKey)) {
        const [x, y] = finalKey.split(',').map(Number); path.unshift({ x: x * size, y: y * size }); finalKey = parents.get(finalKey);
      }
      const smooth = []; let current = start, index = 0;
      while (index < path.length) {
        let farthest = index;
        for (let j = index; j < path.length; j++) { if (clearLine(current, path[j])) farthest = j; else break; }
        smooth.push(path[farthest]); current = path[farthest]; index = farthest + 1;
      }
      return smooth;
    }
    const started = performance.now();
    let targetId = '', path = [], lastProgress = 0;
    const progress = [];
    return await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        try {
          const snapshot = window.__DRIFT__.snapshot(), s = snapshot.state;
          if (snapshot.missionComplete) { clearInterval(timer); release(); resolve({ recovered: snapshot.recoveredCount, time: snapshot.elapsed, hull: s.hull, progress }); return; }
          if (snapshot.modalOpen) throw new Error(`Flight interrupted: hull ${s.hull}, recovered ${snapshot.recoveredCount}`);
          if (performance.now() - started > 240000) throw new Error(`Mission timed out: recovered ${snapshot.recoveredCount}, position ${JSON.stringify(s.position)}, velocity ${JSON.stringify(s.velocity)}, time ${snapshot.elapsed}`);
          const cargo = snapshot.cargos.find(c => !c.collected);
          const goal = cargo?.position || STATION;
          const nextId = cargo?.id || 'station';
          if (nextId !== targetId) { targetId = nextId; path = plan(s.position, goal); progress.push({ targetId, waypoints: path.length, time: snapshot.elapsed }); }
          const speed = len(s.velocity.x, s.velocity.y), goalDistance = len(goal.x - s.position.x, goal.y - s.position.y);
          if (goalDistance < (cargo ? 74 : 112) && speed < (cargo ? 11.8 : 7.8)) { release(); tap('KeyR'); return; }
          while (path.length > 1 && len(path[0].x - s.position.x, path[0].y - s.position.y) < 35) path.shift();
          const point = path[0], dx = point.x - s.position.x, dy = point.y - s.position.y, dist = len(dx, dy);
          const desiredSpeed = Math.min(29, Math.max(0, (dist - (path.length === 1 ? 20 : 0)) * 0.18));
          const dvx = dx / Math.max(dist, 0.1) * desiredSpeed - s.velocity.x;
          const dvy = dy / Math.max(dist, 0.1) * desiredSpeed - s.velocity.y;
          const forward = -Math.sin(s.angle) * dvx + Math.cos(s.angle) * dvy;
          const sideways = Math.cos(s.angle) * dvx + Math.sin(s.angle) * dvy;
          setKey('KeyW', forward > 1.8); setKey('KeyS', forward < -0.8);
          setKey('KeyE', sideways > 0.6); setKey('KeyQ', sideways < -0.6);
          if (snapshot.elapsed - lastProgress > 20) { lastProgress = snapshot.elapsed; console.log(`Test pilot: ${targetId}, ${Math.round(goalDistance)} m, ${speed.toFixed(1)} m/s, hull ${Math.round(s.hull)}`); }
        } catch (error) { clearInterval(timer); release(); reject(error); }
      }, 35);
    });
  });
  assert.equal(result.recovered, 3);
  assert(result.hull > 0);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator('#dialog-title').filter({ hasText: 'You brought them home.' }).waitFor();
  await page.screenshot({ path: 'artifacts/mission-complete.png' });
  await page.locator('#next-sortie').click();
  const replay = await page.evaluate(() => window.__DRIFT__.snapshot());
  assert.equal(replay.recoveredCount, 0); assert.equal(replay.missionComplete, false); assert.equal(replay.state.fuel, 16000);
  writeFileSync('artifacts/mission-results.json', JSON.stringify({ passed: true, ...result, replay: true }, null, 2));
}
