import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

/** An external test pilot issues ordinary key events; it cannot mutate game state. */
export async function runMission(page) {
  // Watches the run from outside the pilot: the first frame with hostiles on scope gets captured.
  const watcher = (async () => {
    for (let i = 0; i < 600; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const hostiles = await page.evaluate(() => { try { return window.__DRIFT__.snapshot().combat.hostiles.length; } catch { return 0; } }).catch(() => 0);
      if (hostiles > 0) {
        await page.screenshot({ path: 'artifacts/hostiles-engaged.png' }).catch(() => {});
        return hostiles;
      }
    }
    return 0;
  })();
  const result = await page.evaluate(async () => {
    const { createObstacles, createCargo, STATION, RELAY } = await import('/src/physics.ts');
    const { SCAN } = await import('/src/contracts.ts');
    const rocks = createObstacles().filter(rock => rock.z === 0);
    const cargos = createCargo();

    // Stand-off distances sit inside each interaction envelope: relay 145 m, scan 130 m, recovery 75 m, docking 115 m.
    const legs = [
      { id: 'relay', position: RELAY, standoff: 95, kind: 'relay' },
      ...cargos.filter(cargo => cargo.kind === 'archive').map(cargo => ({ id: cargo.id, position: cargo.position, standoff: 58, kind: 'recover' })),
      { id: 'blackbox', position: cargos.find(cargo => cargo.kind === 'blackbox').position, standoff: 58, kind: 'recover' },
      { id: 'station', position: STATION, standoff: 88, kind: 'dock' },
    ];

    const pressed = new Set();
    const setKey = (code, down) => {
      if (pressed.has(code) === down) return;
      if (down) pressed.add(code); else pressed.delete(code);
      window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }));
    };
    const release = () => { for (const code of [...pressed]) setKey(code, false); };
    const tap = code => { setKey(code, true); setKey(code, false); };
    // Guns follow the mouse, so the pilot aims the way a player does: a real pointer event at the target.
    const canvas = document.querySelector('#space-canvas');
    const aimAt = (world) => {
      const point = window.__DRIFT__.project(world.x, world.y);
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + point.x, clientY: rect.top + point.y, bubbles: true }));
    };
    const len = (x, y) => Math.hypot(x, y);
    function nearestRockDistance(position) {
      let nearest = Infinity;
      for (const rock of rocks) {
        const gap = len(rock.x - position.x, rock.y - position.y) - rock.radius * 0.83;
        if (gap < nearest) nearest = gap;
      }
      return nearest;
    }
    function clearLine(a, b, clearance) {
      const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
      return !rocks.some(r => {
        const t = d2 ? Math.max(0, Math.min(1, ((r.x - a.x) * dx + (r.y - a.y) * dy) / d2)) : 0;
        return len(r.x - a.x - dx * t, r.y - a.y - dy * t) < r.radius * 0.83 + clearance;
      });
    }
    function plan(start, goal, clearance) {
      if (clearLine(start, goal, clearance)) return [goal];
      const size = 50;
      const encode = (x, y) => `${x},${y}`;
      const initial = { x: Math.round(start.x / size), y: Math.round(start.y / size) };
      const end = { x: Math.round(goal.x / size), y: Math.round(goal.y / size) };
      const open = [{ ...initial, score: 0 }], visited = new Set(), costs = new Map([[encode(initial.x, initial.y), 0]]), parents = new Map();
      let finalKey;
      for (let iteration = 0; iteration < 15000 && open.length; iteration++) {
        open.sort((a, b) => a.score - b.score);
        const current = open.shift(), key = encode(current.x, current.y);
        if (visited.has(key)) continue;
        visited.add(key);
        if (current.x === end.x && current.y === end.y) { finalKey = key; break; }
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue;
          const nx = current.x + dx, ny = current.y + dy, nextKey = encode(nx, ny);
          if (Math.abs(nx) > 56 || Math.abs(ny) > 46 || visited.has(nextKey)) continue;
          if (!clearLine({ x: current.x * size, y: current.y * size }, { x: nx * size, y: ny * size }, clearance)) continue;
          const cost = costs.get(key) + Math.hypot(dx, dy);
          if (cost >= (costs.get(nextKey) ?? Infinity)) continue;
          costs.set(nextKey, cost); parents.set(nextKey, key);
          open.push({ x: nx, y: ny, score: cost + len(end.x - nx, end.y - ny) * 1.05 });
        }
      }
      if (!finalKey) throw new Error(`Could not plan a collision-free route to ${goal.x},${goal.y}`);
      const path = [goal];
      while (parents.has(finalKey)) {
        const [x, y] = finalKey.split(',').map(Number); path.unshift({ x: x * size, y: y * size }); finalKey = parents.get(finalKey);
      }
      const smooth = []; let current = start, index = 0;
      while (index < path.length) {
        let farthest = index;
        for (let j = index; j < path.length; j++) { if (clearLine(current, path[j], clearance)) farthest = j; else break; }
        smooth.push(path[farthest]); current = path[farthest]; index = farthest + 1;
      }
      return smooth;
    }

    /** Try a wide corridor first, then progressively tighter ones; a straight line is the last resort. */
    function routeTo(start, goal) {
      // The hull is ~118 m long, so a corridor has to clear half of that plus margin on each side.
      for (const clearance of [78, 62, 48, 34]) {
        try { return { path: plan(start, goal, clearance), clearance }; } catch { /* tighten and retry */ }
      }
      return { path: [goal], clearance: 0 };
    }

    const started = performance.now();
    let legIndex = 0;
    let path = [];
    let replanned = 0;
    let lastLog = 0;
    let aiming = false;
    let hostilesSeen = 0;
    const progress = [];
    return await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        try {
          const snapshot = window.__DRIFT__.snapshot();
          const ship = snapshot.state;
          if (snapshot.missionComplete) {
            release(); clearInterval(timer);
            resolve({ time: snapshot.elapsed, hull: ship.hull, payout: snapshot.payout, progress, hostilesSeen, killed: snapshot.combat.hostilesKilled, bounty: snapshot.combat.pendingBounty });
            return;
          }
          if (snapshot.modalOpen || snapshot.crashed) throw new Error(`Flight interrupted: hull ${ship.hull}, fuel ${ship.fuel}, recovered ${snapshot.recoveredCount}`);
          if (performance.now() - started > 900000) throw new Error(`Mission timed out on leg ${legIndex}: position ${JSON.stringify(ship.position)}, time ${snapshot.elapsed}`);

          const leg = legs[legIndex];
          if (!leg) throw new Error('Test pilot ran out of legs before docking');
          if (leg.kind === 'relay' && snapshot.stage !== 0) { legIndex++; path = []; return; }
          const cargo = snapshot.cargos.find(item => item.id === leg.id);
          if (leg.kind === 'recover' && cargo?.collected) { legIndex++; path = []; return; }

          // Anything hostile inside engagement range becomes the goal: this contract spawns raiders
          // once the relay telemetry lands, and a salvage run that ignores them dies in the belt.
          const threat = snapshot.combat.hostiles
            .map(h => ({ h, range: len(h.x - ship.position.x, h.y - ship.position.y) }))
            .sort((a, b) => a.range - b.range)[0];
          if (threat && threat.range < 1250) {
            aiming = true;
            aimAt({ x: threat.h.x, y: threat.h.y });
            setKey('Space', threat.range < 900);
            hostilesSeen = Math.max(hostilesSeen, snapshot.combat.hostiles.length);
          } else if (aiming) {
            aiming = false;
            setKey('Space', false);
          }

          const goal = threat && threat.range < 1250 ? { x: threat.h.x, y: threat.h.y } : leg.position;
          const speed = len(ship.velocity.x, ship.velocity.y);
          const distance = len(goal.x - ship.position.x, goal.y - ship.position.y);

          if (!threat && distance < leg.standoff && speed < 2.6) {
            release();
            const ready = leg.kind === 'relay' || leg.kind === 'dock' || snapshot.scanned.includes(leg.id);
            if (ready && leg.kind !== 'relay') tap('KeyR');
            return;
          }

          if (!path.length || snapshot.elapsed - replanned > 12) {
            const route = routeTo(ship.position, goal);
            path = route.path;
            replanned = snapshot.elapsed;
            progress.push({ leg: leg.id, waypoints: path.length, clearance: route.clearance, time: snapshot.elapsed });
          }
          while (path.length > 1 && len(path[0].x - ship.position.x, path[0].y - ship.position.y) < 32) path.shift();
          const point = path[0];
          const dx = point.x - ship.position.x, dy = point.y - ship.position.y;
          const target = len(dx, dy);
          const ux = dx / Math.max(target, 0.01), uy = dy / Math.max(target, 0.01);
          const remaining = Math.max(0, target - (path.length === 1 ? leg.standoff * 0.7 : 20));
          const margin = nearestRockDistance(ship.position);
          const ceiling = margin < 70 ? 20 : margin < 130 ? 60 : 120;
          const cruise = Math.min(ceiling, Math.sqrt(2 * 6 * remaining));
          const dvx = ux * cruise - ship.velocity.x, dvy = uy * cruise - ship.velocity.y;
          const forward = -Math.sin(ship.angle) * dvx + Math.cos(ship.angle) * dvy;
          const sideways = Math.cos(ship.angle) * dvx + Math.sin(ship.angle) * dvy;
          let error = Math.atan2(-dvx, dvy) - ship.angle;
          while (error > Math.PI) error -= Math.PI * 2;
          while (error < -Math.PI) error += Math.PI * 2;
          setKey('KeyA', error > 0.05);
          setKey('KeyD', error < -0.05);
          setKey('KeyW', forward > 0.6 && Math.abs(error) < 1.1);
          setKey('KeyS', forward < -0.6 && Math.abs(error) < 1.1);
          setKey('KeyQ', sideways < -0.8);
          setKey('KeyE', sideways > 0.8);
          if (snapshot.elapsed - lastLog > 20) {
            lastLog = snapshot.elapsed;
            console.log(`Test pilot: ${leg.id}, ${Math.round(distance)} m out, ${speed.toFixed(1)} m/s, hull ${Math.round(ship.hull)}, fuel ${Math.round(ship.fuel)}`);
          }
        } catch (error) { release(); clearInterval(timer); reject(error); }
      }, 35);
    });
  });
  // SR-084: 2,800 contract payment plus the 4,200 black-box bonus objective.
  assert.equal(result.payout, 2800 + 4200);
  assert(result.hull > 0);
  assert(result.hostilesSeen >= 2, 'SR-084 spawns its raiders once the telemetry lands');
  await watcher;
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator('#dialog-title').filter({ hasText: 'done.' }).waitFor();
  await page.screenshot({ path: 'artifacts/mission-complete.png' });
  await page.locator('#next-sortie').click();
  await page.locator('#launch-sortie').waitFor();
  const docked = await page.evaluate(() => window.__DRIFT__.snapshot());
  assert.equal(docked.flow, 'hangar');
  assert.equal(docked.payout, 2800 + 4200, 'hangar keeps the finished contract on the books until relaunch');
  await page.locator('#launch-sortie').click();
  await page.waitForFunction(() => window.__DRIFT__.snapshot().flow === 'flight', { timeout: 20000 });
  const relaunched = await page.evaluate(() => window.__DRIFT__.snapshot());
  assert.equal(relaunched.recoveredCount, 0); assert.equal(relaunched.missionComplete, false); assert.equal(relaunched.payout, 0);
  assert(relaunched.state.fuel > 15500, 'relaunched sortie refills propellant');
  writeFileSync('artifacts/mission-results.json', JSON.stringify({ passed: true, ...result, replay: true }, null, 2));
}
