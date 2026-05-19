import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static("public"));

// ========================= CONFIG =========================
const TICK_HZ = 20;
const TICK_DT = 1 / TICK_HZ;

const MAP_HALF = 30;
const PLAYER_HP_MAX = 100;
const PLAYER_RADIUS = 0.35;
const PLAYER_DAMAGE = 28;
const PLAYER_AMMO_MAX = 30;
const PLAYER_RESERVE_MAX = 90;

const WEAPONS = {
  rifle:  { damage: 28, fireRateMs: 110, magSize: 30, reserveMax: 90,  auto: true,  pickupReserve: 60 },
  pistol: { damage: 22, fireRateMs: 220, magSize: 12, reserveMax: 60,  auto: false, pickupReserve: 36 },
};
const DEFAULT_WEAPON = "rifle";

const BOT_HP_MAX = 60;
const BOT_RADIUS = 0.45;
const BOT_BASE_DAMAGE = 14;
const BOT_FIRE_CD_MS = 900;
const BOT_SIGHT = 32;
const BOT_SPEED_RUSH = 4.2;
const BOT_SPEED_HOLD = 1.5;
const WAVE_SIZE = 5;
const WAVE_DELAY_MS = 3000;

const RESPAWN_MS = 5000;
const PICKUP_RESPAWN_MS = 15000;
const SPAWN_INVULN_MS = 3000;

const FF_ON = true;

// Hitboxes (vertical zones in world Y). Head = instant kill.
const PLAYER_BODY_LOW = 0.3, PLAYER_BODY_HIGH = 1.55;
const PLAYER_HEAD_LOW = 1.55, PLAYER_HEAD_HIGH = 1.90;
const BOT_BODY_LOW = 0.30, BOT_BODY_HIGH = 1.40;
const BOT_HEAD_LOW = 1.40, BOT_HEAD_HIGH = 1.90;

const GRENADE_FUSE_MS = 3000;
const GRENADE_RADIUS = 0.18;
const GRENADE_DAMAGE_MAX = 80;
const GRENADE_BLAST_RADIUS = 5.5;
const GRENADE_GRAVITY = 18;
const GRENADE_BOUNCE = 0.4;
const GRENADE_THROW_SPEED = 16;
const GRENADE_COOLDOWN_MS = 6000;

const MELEE = {
  knife: { damage: 45, reach: 1.9, cooldownMs: 550, halfArc: 0.55 },
  axe:   { damage: 95, reach: 2.2, cooldownMs: 1050, halfArc: 0.45 },
};
const DEFAULT_MELEE = "knife";

// Map walls (AABBs in XZ): {x, z, w, d}
const WALLS = [
  { x: 0, z: -MAP_HALF, w: MAP_HALF * 2, d: 1 },
  { x: 0, z: MAP_HALF, w: MAP_HALF * 2, d: 1 },
  { x: -MAP_HALF, z: 0, w: 1, d: MAP_HALF * 2 },
  { x: MAP_HALF, z: 0, w: 1, d: MAP_HALF * 2 },
  { x: -12, z: -10, w: 6, d: 1 },
  { x: 10, z: -12, w: 1, d: 6 },
  { x: 14, z: 8, w: 5, d: 1 },
  { x: -8, z: 12, w: 1, d: 6 },
  { x: 0, z: -2, w: 4, d: 1 },
  { x: 0, z: 2, w: 1, d: 4 },
  { x: -18, z: 6, w: 1, d: 4 },
  { x: 18, z: -6, w: 1, d: 4 },
  { x: 22, z: 18, w: 3, d: 3 },
  { x: -22, z: -18, w: 3, d: 3 },
  { x: -2, z: 18, w: 8, d: 1 },
  { x: 2, z: -18, w: 8, d: 1 },
  { x: 20, z: -20, w: 2, d: 2 },
  { x: -20, z: 20, w: 2, d: 2 },
];

const PLAYER_SPAWN = [-MAP_HALF + 3, 0, -MAP_HALF + 3];

// Pickups: 4 health + 4 ammo, fixed locations
const PICKUP_TEMPLATES = [
  { kind: "health", pos: [12, 0, 12] },
  { kind: "health", pos: [-15, 0, -8] },
  { kind: "health", pos: [-2, 0, -22] },
  { kind: "health", pos: [20, 0, 6] },
  { kind: "ammo", pos: [-12, 0, 0] },
  { kind: "ammo", pos: [16, 0, -14] },
  { kind: "ammo", pos: [-22, 0, 14] },
  { kind: "ammo", pos: [6, 0, 22] },
];

// ========================= GEOMETRY HELPERS =========================
function collidesWalls(x, z, r) {
  for (const w of WALLS) {
    const minX = w.x - w.w / 2 - r, maxX = w.x + w.w / 2 + r;
    const minZ = w.z - w.d / 2 - r, maxZ = w.z + w.d / 2 + r;
    if (x > minX && x < maxX && z > minZ && z < maxZ) return true;
  }
  return false;
}

function resolveWalls(pos, r) {
  for (let i = 0; i < 3; i++) {
    let collided = false;
    for (const w of WALLS) {
      const dx = pos[0] - w.x, dz = pos[2] - w.z;
      const hx = w.w / 2 + r, hz = w.d / 2 + r;
      if (Math.abs(dx) > hx || Math.abs(dz) > hz) continue;
      const overlapX = hx - Math.abs(dx);
      const overlapZ = hz - Math.abs(dz);
      if (overlapX < overlapZ) pos[0] += Math.sign(dx || 1) * overlapX;
      else pos[2] += Math.sign(dz || 1) * overlapZ;
      collided = true;
    }
    if (!collided) break;
  }
}

function rayWallDist(ox, oz, dx, dz, maxDist) {
  let nearest = maxDist;
  for (const w of WALLS) {
    const minX = w.x - w.w / 2, maxX = w.x + w.w / 2;
    const minZ = w.z - w.d / 2, maxZ = w.z + w.d / 2;
    let tmin = 0, tmax = maxDist;
    if (Math.abs(dx) < 1e-6) {
      if (ox < minX || ox > maxX) continue;
    } else {
      let t1 = (minX - ox) / dx, t2 = (maxX - ox) / dx;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
    }
    if (Math.abs(dz) < 1e-6) {
      if (oz < minZ || oz > maxZ) continue;
    } else {
      let t1 = (minZ - oz) / dz, t2 = (maxZ - oz) / dz;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
    }
    if (tmax >= tmin && tmin > 0 && tmin < nearest) nearest = tmin;
  }
  return nearest;
}

function rayCylDist(ox, oz, dx, dz, cx, cz, r, maxDist) {
  const ex = cx - ox, ez = cz - oz;
  const t = ex * dx + ez * dz;
  if (t < 0 || t > maxDist) return Infinity;
  const px = ox + dx * t, pz = oz + dz * t;
  const d = Math.hypot(px - cx, pz - cz);
  if (d > r) return Infinity;
  return t;
}

// 3D ray vs wall AABB (walls are y=0..3).
// Returns nearest positive 3D ray-parameter (t such that hitPoint = origin + t*dir).
function rayWallDist3D(ox, oy, oz, dx, dy, dz, maxDist) {
  let nearest = maxDist;
  for (const w of WALLS) {
    const mins = [w.x - w.w / 2, 0, w.z - w.d / 2];
    const maxs = [w.x + w.w / 2, 3, w.z + w.d / 2];
    const o = [ox, oy, oz], d = [dx, dy, dz];
    let tmin = 0, tmax = maxDist, ok = true;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-6) {
        if (o[i] < mins[i] || o[i] > maxs[i]) { ok = false; break; }
      } else {
        let t1 = (mins[i] - o[i]) / d[i];
        let t2 = (maxs[i] - o[i]) / d[i];
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) { ok = false; break; }
      }
    }
    if (ok && tmin > 0 && tmin < nearest) nearest = tmin;
  }
  return nearest;
}

// 3D ray vs entity (vertical cylinder split into head + body zones).
// Returns { t, zone, pos } for the earliest valid zone hit, or null.
function rayEntityHit(ox, oy, oz, dx, dy, dz, cx, cz, radius, bodyLow, bodyHigh, headLow, headHigh, maxDist) {
  const ax = dx * dx + dz * dz;
  if (ax < 1e-6) return null; // straight up/down — ignore for shoot
  const bx = 2 * (dx * (ox - cx) + dz * (oz - cz));
  const cc = (ox - cx) * (ox - cx) + (oz - cz) * (oz - cz) - radius * radius;
  const disc = bx * bx - 4 * ax * cc;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const tEnter = (-bx - sq) / (2 * ax);
  const tExit  = (-bx + sq) / (2 * ax);
  if (tExit < 0) return null;
  const cylEntry = Math.max(tEnter, 0);
  if (cylEntry > maxDist) return null;

  function tRangeY(yLow, yHigh) {
    if (Math.abs(dy) < 1e-6) {
      if (oy < yLow || oy > yHigh) return null;
      return [-Infinity, Infinity];
    }
    let ta = (yLow - oy) / dy, tb = (yHigh - oy) / dy;
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    return [ta, tb];
  }

  let best = null;
  const zones = [
    ["head", headLow, headHigh],
    ["body", bodyLow, bodyHigh],
  ];
  for (const [name, lo, hi] of zones) {
    const yr = tRangeY(lo, hi);
    if (!yr) continue;
    const entry = Math.max(cylEntry, yr[0]);
    const exit = Math.min(tExit, yr[1]);
    if (entry > exit + 1e-6) continue;
    if (entry > maxDist) continue;
    if (!best || entry < best.t) {
      best = { t: entry, zone: name, pos: [ox + dx * entry, oy + dy * entry, oz + dz * entry] };
    }
  }
  return best;
}

function randomSpawn(awayFrom, minDist) {
  for (let i = 0; i < 200; i++) {
    const x = (Math.random() - 0.5) * (MAP_HALF * 2 - 4);
    const z = (Math.random() - 0.5) * (MAP_HALF * 2 - 4);
    if (Math.hypot(x - awayFrom[0], z - awayFrom[2]) < minDist) continue;
    if (collidesWalls(x, z, BOT_RADIUS + 0.2)) continue;
    return [x, 0, z];
  }
  return [MAP_HALF - 3, 0, MAP_HALF - 3];
}

// ========================= ROOM/GAME STATE =========================
const rooms = new Map();

function getRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    room = { id, clients: new Map(), game: null };
    rooms.set(id, room);
  }
  return room;
}

function freshWeaponState() {
  const out = {};
  for (const [k, w] of Object.entries(WEAPONS)) {
    out[k] = { ammo: w.magSize, reserve: w.reserveMax };
  }
  return out;
}

function makePlayer(id, name, prior) {
  const weapons = freshWeaponState();
  return {
    id, name,
    hp: PLAYER_HP_MAX,
    weapon: DEFAULT_WEAPON,
    weapons,
    pos: [...PLAYER_SPAWN], yaw: 0, pitch: 0,
    kills: 0, deaths: 0,
    deadUntil: 0, lastFire: 0, lastGrenade: 0, lastMelee: 0,
    invulnUntil: Date.now() + SPAWN_INVULN_MS,
    color: (prior && prior.color) || 0x4488ff,
    melee: (prior && prior.melee) || DEFAULT_MELEE,
  };
}

function makeBoss(tier, game) {
  const id = `b${game.botCounter++}`;
  const maxHp = 400 + (tier - 1) * 300;
  return {
    id,
    pos: randomSpawn(PLAYER_SPAWN, 22),
    yaw: Math.random() * Math.PI * 2,
    hp: maxHp,
    maxHp,
    lastFire: 0,
    style: "boss",
    boss: true,
    tier,
    damage: 16 + (tier - 1) * 6,
    fireCdMs: Math.max(220, 800 - tier * 100),
    speed: 3.2 + (tier - 1) * 0.35,
    sight: 50,
    radius: BOT_RADIUS * (1.5 + Math.min(tier, 5) * 0.15),
    desiredDist: 8,
  };
}

function spawnWave(game) {
  const nextWave = game.wave + 1;
  const isBossWave = nextWave % 5 === 0;
  const styles = ["rush", "hold"];

  if (isBossWave) {
    const tier = Math.floor(nextWave / 5);
    game.bots.push(makeBoss(tier, game));
    const minions = Math.min(3 + Math.floor(tier / 2), 7);
    for (let i = 0; i < minions; i++) {
      const id = `b${game.botCounter++}`;
      const style = styles[Math.floor(Math.random() * styles.length)];
      game.bots.push({
        id,
        pos: randomSpawn(PLAYER_SPAWN, 18),
        yaw: Math.random() * Math.PI * 2,
        hp: BOT_HP_MAX,
        maxHp: BOT_HP_MAX,
        lastFire: 0,
        style,
      });
    }
    game.wave++;
    game.events.push({ type: "wave-start", wave: game.wave, size: minions + 1, boss: true, bossTier: tier });
    game.events.push({ type: "mission", text: `BOSS WAVE — MK.${toRoman(tier)} INCOMING` });
  } else {
    for (let i = 0; i < WAVE_SIZE; i++) {
      const id = `b${game.botCounter++}`;
      const style = styles[Math.floor(Math.random() * styles.length)];
      game.bots.push({
        id,
        pos: randomSpawn(PLAYER_SPAWN, 18),
        yaw: Math.random() * Math.PI * 2,
        hp: BOT_HP_MAX,
        maxHp: BOT_HP_MAX,
        lastFire: 0,
        style,
      });
    }
    game.wave++;
    game.events.push({ type: "wave-start", wave: game.wave, size: WAVE_SIZE, boss: false });
  }
}

function toRoman(n) {
  const map = [["M",1000],["CM",900],["D",500],["CD",400],["C",100],["XC",90],["L",50],["XL",40],["X",10],["IX",9],["V",5],["IV",4],["I",1]];
  let s = "";
  for (const [r, v] of map) { while (n >= v) { s += r; n -= v; } }
  return s || "I";
}

function startGame(room) {
  const pickups = PICKUP_TEMPLATES.map((p, i) => ({
    id: `pk${i}`, kind: p.kind, pos: [...p.pos], available: true, respawnAt: 0,
  }));
  room.game = {
    bots: [],
    botCounter: 0,
    wave: 0,
    pickups,
    grenades: [],
    grenadeCounter: 0,
    events: [],
    over: null,
    startedAt: Date.now(),
    nextWaveAt: Date.now() + 1500,
    missionAt20: false,
  };
  for (const c of room.clients.values()) {
    const prior = c.player || ((c._pendingColor != null || c._pendingMelee) ? { color: c._pendingColor, melee: c._pendingMelee } : null);
    c.player = makePlayer(c.id, c.name, prior);
  }
  broadcast(room.id, {
    type: "game-start",
    walls: WALLS,
    spawn: PLAYER_SPAWN,
    mapHalf: MAP_HALF,
    pickups: pickups.map(p => ({ id: p.id, kind: p.kind, pos: p.pos })),
  });
}

function tickGame(room) {
  const game = room.game;
  if (!game) return;
  const now = Date.now();

  const players = [...room.clients.values()].filter(c => c.player).map(c => c.player);

  // Respawn players (endless waves: always respawn, no loss state)
  for (const p of players) {
    if (p.hp <= 0 && p.deadUntil <= now) {
      p.hp = PLAYER_HP_MAX;
      p.weapon = DEFAULT_WEAPON;
      p.weapons = freshWeaponState();
      p.pos = [...PLAYER_SPAWN];
      p.deadUntil = 0;
      p.invulnUntil = now + SPAWN_INVULN_MS;
    }
  }

  // Wave spawning
  if (!game.over) {
    const liveBots = game.bots.filter(b => b.hp > 0).length;
    if (liveBots === 0 && now >= game.nextWaveAt) {
      spawnWave(game);
      game.nextWaveAt = now + WAVE_DELAY_MS;
      const totalKilled = game.wave * WAVE_SIZE - liveBots;
      if (game.wave * WAVE_SIZE >= 20 && !game.missionAt20) {
        // we'll fire mission milestone after the 20th kill, handled there
      }
    }
  }

  // Bot AI
  for (const bot of game.bots) {
    if (bot.hp <= 0) continue;

    const sight = bot.sight ?? BOT_SIGHT;
    const fireCd = bot.fireCdMs ?? BOT_FIRE_CD_MS;
    const damage = bot.damage ?? BOT_BASE_DAMAGE;
    const radius = bot.radius ?? BOT_RADIUS;

    let target = null, minDist = Infinity;
    for (const p of players) {
      if (p.hp <= 0) continue;
      const d = Math.hypot(p.pos[0] - bot.pos[0], p.pos[2] - bot.pos[2]);
      if (d < minDist) { minDist = d; target = p; }
    }
    if (!target) continue;

    const dx = target.pos[0] - bot.pos[0], dz = target.pos[2] - bot.pos[2];
    const dist = Math.hypot(dx, dz);
    if (dist < 0.001) continue;
    const nx = dx / dist, nz = dz / dist;
    bot.yaw = Math.atan2(nx, nz);

    const wallDist = rayWallDist(bot.pos[0], bot.pos[2], nx, nz, dist);
    const hasLOS = wallDist >= dist - 0.5;

    if (hasLOS && dist < sight) {
      if (now - bot.lastFire > fireCd) {
        bot.lastFire = now;
        // Bosses (tier >= 2) fire a small spread burst; tier 4+ wider
        const burst = bot.boss && bot.tier >= 2 ? Math.min(1 + Math.floor(bot.tier / 2), 4) : 1;
        const spread = bot.boss ? 0.06 + bot.tier * 0.015 : 0;
        const baseAcc = Math.max(0.25, 0.85 - dist / 50);
        for (let s = 0; s < burst; s++) {
          const off = burst === 1 ? 0 : (s - (burst - 1) / 2) * spread;
          const ang = Math.atan2(nz, nx) + off;
          const sdx = Math.cos(ang), sdz = Math.sin(ang);
          const hit = Math.random() < baseAcc;
          const endX = bot.pos[0] + sdx * (hit ? dist : 40);
          const endZ = bot.pos[2] + sdz * (hit ? dist : 40);
          game.events.push({
            type: "bot-shot",
            botId: bot.id,
            from: [bot.pos[0], bot.boss ? 1.8 : 1.4, bot.pos[2]],
            to: [endX, bot.boss ? 1.8 : 1.4, endZ],
            hit,
            boss: !!bot.boss,
          });
          if (hit && now > target.invulnUntil) {
            target.hp = Math.max(0, target.hp - damage);
            if (target.hp <= 0) {
              target.deaths++;
              target.deadUntil = now + RESPAWN_MS;
              const killerName = bot.boss ? `BOSS Mk.${toRoman(bot.tier)}` : "Bot";
              game.events.push({ type: "kill", killer: bot.id, killerName, victim: target.id, victimName: target.name });
              break;
            } else {
              game.events.push({ type: "hit-player", target: target.id, hp: target.hp });
            }
          }
        }
      }
      let speed;
      if (bot.boss) speed = bot.speed;
      else speed = bot.style === "rush" ? BOT_SPEED_RUSH : BOT_SPEED_HOLD;
      const desired = bot.boss ? (bot.desiredDist ?? 8) : (bot.style === "rush" ? 3 : 12);
      if (dist > desired + 1) {
        bot.pos[0] += nx * speed * TICK_DT;
        bot.pos[2] += nz * speed * TICK_DT;
      } else if (dist < desired - 1) {
        bot.pos[0] -= nx * speed * TICK_DT;
        bot.pos[2] -= nz * speed * TICK_DT;
      }
    } else {
      let speed;
      if (bot.boss) speed = bot.speed * 0.9;
      else speed = bot.style === "rush" ? BOT_SPEED_RUSH * 0.8 : BOT_SPEED_HOLD;
      bot.pos[0] += nx * speed * TICK_DT;
      bot.pos[2] += nz * speed * TICK_DT;
    }

    resolveWalls(bot.pos, radius);
  }

  // Pickups: check player overlap
  for (const p of players) {
    if (p.hp <= 0) continue;
    for (const pk of game.pickups) {
      if (!pk.available) continue;
      const d = Math.hypot(p.pos[0] - pk.pos[0], p.pos[2] - pk.pos[2]);
      if (d < 0.9) {
        let used = false;
        if (pk.kind === "health" && p.hp < PLAYER_HP_MAX) {
          p.hp = Math.min(PLAYER_HP_MAX, p.hp + 50);
          used = true;
        } else if (pk.kind === "ammo") {
          for (const [k, w] of Object.entries(WEAPONS)) {
            const ws = p.weapons[k];
            if (ws && ws.reserve < w.reserveMax) {
              ws.reserve = Math.min(w.reserveMax, ws.reserve + w.pickupReserve);
              used = true;
            }
          }
        }
        if (used) {
          pk.available = false;
          pk.respawnAt = now + PICKUP_RESPAWN_MS;
          game.events.push({ type: "pickup", id: pk.id, by: p.id, kind: pk.kind });
        }
      }
    }
  }
  for (const pk of game.pickups) {
    if (!pk.available && now >= pk.respawnAt) {
      pk.available = true;
      game.events.push({ type: "pickup-respawn", id: pk.id });
    }
  }

  // Grenade simulation
  for (const g of game.grenades) {
    if (g.exploded) continue;
    g.vel[1] -= GRENADE_GRAVITY * TICK_DT;
    g.pos[0] += g.vel[0] * TICK_DT;
    g.pos[1] += g.vel[1] * TICK_DT;
    g.pos[2] += g.vel[2] * TICK_DT;
    if (g.pos[1] < GRENADE_RADIUS) {
      g.pos[1] = GRENADE_RADIUS;
      g.vel[1] = -g.vel[1] * GRENADE_BOUNCE;
      g.vel[0] *= 0.7;
      g.vel[2] *= 0.7;
    }
    if (g.pos[0] < -MAP_HALF + GRENADE_RADIUS) { g.pos[0] = -MAP_HALF + GRENADE_RADIUS; g.vel[0] = -g.vel[0] * GRENADE_BOUNCE; }
    if (g.pos[0] > MAP_HALF - GRENADE_RADIUS) { g.pos[0] = MAP_HALF - GRENADE_RADIUS; g.vel[0] = -g.vel[0] * GRENADE_BOUNCE; }
    if (g.pos[2] < -MAP_HALF + GRENADE_RADIUS) { g.pos[2] = -MAP_HALF + GRENADE_RADIUS; g.vel[2] = -g.vel[2] * GRENADE_BOUNCE; }
    if (g.pos[2] > MAP_HALF - GRENADE_RADIUS) { g.pos[2] = MAP_HALF - GRENADE_RADIUS; g.vel[2] = -g.vel[2] * GRENADE_BOUNCE; }
    // Wall AABB bounce in XZ (push out and reverse dominant axis)
    for (const w of WALLS) {
      const dx = g.pos[0] - w.x, dz = g.pos[2] - w.z;
      const hx = w.w / 2 + GRENADE_RADIUS, hz = w.d / 2 + GRENADE_RADIUS;
      if (Math.abs(dx) > hx || Math.abs(dz) > hz) continue;
      const overlapX = hx - Math.abs(dx);
      const overlapZ = hz - Math.abs(dz);
      if (overlapX < overlapZ) {
        g.pos[0] += Math.sign(dx || 1) * overlapX;
        g.vel[0] = -g.vel[0] * GRENADE_BOUNCE;
      } else {
        g.pos[2] += Math.sign(dz || 1) * overlapZ;
        g.vel[2] = -g.vel[2] * GRENADE_BOUNCE;
      }
    }
    if (now >= g.fuseAt) {
      g.exploded = true;
      g.explodedAt = now;
      // Apply splash damage
      const owner = players.find(p => p.id === g.ownerId);
      const ownerName = owner ? owner.name : "Grenade";
      for (const b of game.bots) {
        if (b.hp <= 0) continue;
        const d = Math.hypot(b.pos[0] - g.pos[0], b.pos[2] - g.pos[2]);
        if (d > GRENADE_BLAST_RADIUS) continue;
        const dmg = Math.round(GRENADE_DAMAGE_MAX * (1 - d / GRENADE_BLAST_RADIUS));
        if (dmg <= 0) continue;
        b.hp = Math.max(0, b.hp - dmg);
        if (b.hp <= 0 && owner) {
          const bonus = b.boss ? b.tier : 0;
          owner.kills += 1 + bonus;
          const victimName = b.boss ? `BOSS Mk.${toRoman(b.tier)}` : "Bot";
          game.events.push({ type: "kill", killer: owner.id, killerName: owner.name, victim: b.id, victimName, boss: !!b.boss, tier: b.tier || 0 });
        }
      }
      for (const p of players) {
        if (p.hp <= 0) continue;
        if (now < p.invulnUntil) continue;
        const d = Math.hypot(p.pos[0] - g.pos[0], p.pos[2] - g.pos[2]);
        if (d > GRENADE_BLAST_RADIUS) continue;
        const isOwn = owner && p.id === owner.id;
        if (!FF_ON && !isOwn) continue; // peers safe if FF off
        const dmg = Math.round(GRENADE_DAMAGE_MAX * (1 - d / GRENADE_BLAST_RADIUS));
        if (dmg <= 0) continue;
        p.hp = Math.max(0, p.hp - dmg);
        if (p.hp <= 0) {
          p.deaths++;
          p.deadUntil = now + RESPAWN_MS;
          if (owner && !isOwn) owner.kills--;
          game.events.push({ type: "kill", killer: owner ? owner.id : null, killerName: ownerName, victim: p.id, victimName: p.name, friendly: !isOwn && owner != null });
        }
      }
      game.events.push({ type: "explode", pos: [...g.pos], by: g.ownerId });
    }
  }
  game.grenades = game.grenades.filter(g => !g.exploded || now - g.explodedAt < 200);

  // Mission milestone at 20 kills
  if (!game.missionAt20) {
    const totalKills = players.reduce((s, p) => s + p.kills, 0);
    if (totalKills >= 20) {
      game.missionAt20 = true;
      game.events.push({ type: "mission", text: "Mission cleared! 20 bots down. Keep going for high score." });
    }
  }

  // Broadcast tick
  const msg = {
    type: "tick",
    t: now,
    wave: game.wave,
    nextWaveIn: game.nextWaveAt > now ? game.nextWaveAt - now : 0,
    over: game.over,
    players: players.map(p => {
      const ws = p.weapons[p.weapon] || { ammo: 0, reserve: 0 };
      return {
        id: p.id, name: p.name, pos: p.pos, yaw: p.yaw, pitch: p.pitch,
        hp: p.hp, weapon: p.weapon, ammo: ws.ammo, reserve: ws.reserve,
        weapons: p.weapons,
        kills: p.kills, deaths: p.deaths, deadUntil: p.deadUntil,
        invulnUntil: p.invulnUntil, color: p.color,
        grenadeCooldownLeft: Math.max(0, GRENADE_COOLDOWN_MS - (now - p.lastGrenade)),
        melee: p.melee,
        meleeCooldownLeft: Math.max(0, (MELEE[p.melee] || MELEE[DEFAULT_MELEE]).cooldownMs - (now - p.lastMelee)),
      };
    }),
    bots: game.bots.map(b => ({
      id: b.id, pos: b.pos, yaw: b.yaw, hp: b.hp, style: b.style,
      maxHp: b.maxHp ?? BOT_HP_MAX,
      boss: !!b.boss, tier: b.tier || 0,
    })),
    grenades: game.grenades.map(g => ({ id: g.id, pos: g.pos, exploded: g.exploded })),
    pickups: game.pickups.map(p => ({ id: p.id, available: p.available })),
    events: game.events,
  };
  broadcast(room.id, msg);
  game.events = [];
}

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.game) tickGame(room);
  }
}, 1000 / TICK_HZ);

// ========================= WEBSOCKET =========================
function broadcast(roomId, payload, exceptId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const data = JSON.stringify(payload);
  for (const [id, c] of room.clients) {
    if (id === exceptId) continue;
    if (c.ws.readyState === 1) c.ws.send(data);
  }
}

function roster(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return [...room.clients.values()].map(c => ({ id: c.id, name: c.name }));
}

wss.on("connection", (ws) => {
  const clientId = randomUUID();
  let roomId = null;
  let name = "anon";

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "join") {
      roomId = String(msg.room || "lobby").slice(0, 32);
      name = String(msg.name || "anon").slice(0, 24);
      const room = getRoom(roomId);
      room.clients.set(clientId, { id: clientId, ws, name, player: null });
      ws.send(JSON.stringify({
        type: "joined",
        id: clientId, room: roomId, roster: roster(roomId),
        inGame: !!room.game,
        walls: room.game ? WALLS : null,
        mapHalf: room.game ? MAP_HALF : null,
        spawn: room.game ? PLAYER_SPAWN : null,
        pickups: room.game ? room.game.pickups.map(p => ({ id: p.id, kind: p.kind, pos: p.pos })) : null,
      }));
      broadcast(roomId, { type: "peer-joined", id: clientId, name, roster: roster(roomId) }, clientId);
      // If already in-game, hot-join: create player
      const r = rooms.get(roomId);
      if (r && r.game) {
        const cli = r.clients.get(clientId);
        const prior = (cli._pendingColor != null || cli._pendingMelee) ? { color: cli._pendingColor, melee: cli._pendingMelee } : null;
        cli.player = makePlayer(clientId, name, prior);
      }
      return;
    }

    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const client = room.clients.get(clientId);
    if (!client) return;

    if (msg.type === "chat") {
      broadcast(roomId, { type: "chat", from: clientId, name, text: String(msg.text || "").slice(0, 500) });
      return;
    }

    if (msg.type === "start") {
      if (!room.game) startGame(room);
      return;
    }

    if (msg.type === "restart") {
      startGame(room);
      return;
    }

    if (msg.type === "input" && room.game && client.player) {
      const p = client.player;
      if (p.hp <= 0) {
        if (typeof msg.yaw === "number") p.yaw = msg.yaw;
        if (typeof msg.pitch === "number") p.pitch = msg.pitch;
        return;
      }
      if (Array.isArray(msg.pos) && msg.pos.length === 3) {
        const x = Math.max(-MAP_HALF + 0.5, Math.min(MAP_HALF - 0.5, msg.pos[0]));
        const z = Math.max(-MAP_HALF + 0.5, Math.min(MAP_HALF - 0.5, msg.pos[2]));
        p.pos = [x, msg.pos[1] || 0, z];
      }
      if (typeof msg.yaw === "number") p.yaw = msg.yaw;
      if (typeof msg.pitch === "number") p.pitch = msg.pitch;
      return;
    }

    if (msg.type === "shoot" && room.game && client.player) {
      const p = client.player;
      const now = Date.now();
      if (p.hp <= 0) return;
      const wdef = WEAPONS[p.weapon] || WEAPONS[DEFAULT_WEAPON];
      const wstate = p.weapons[p.weapon];
      if (!wstate || wstate.ammo <= 0) return;
      if (now - p.lastFire < wdef.fireRateMs) return;
      p.lastFire = now;
      wstate.ammo--;
      const weaponDamage = wdef.damage;

      const ox = msg.origin?.[0] ?? p.pos[0];
      const oy = msg.origin?.[1] ?? 1.6;
      const oz = msg.origin?.[2] ?? p.pos[2];
      const dx = msg.dir?.[0] ?? 0;
      const dy_ = msg.dir?.[1] ?? 0;
      const dz = msg.dir?.[2] ?? 0;
      const dlen = Math.hypot(dx, dy_, dz);
      if (dlen < 0.01) return;
      const ndx = dx / dlen, ndy = dy_ / dlen, ndz = dz / dlen;

      const MAX_RANGE = 60;
      let hitDist = rayWallDist3D(ox, oy, oz, ndx, ndy, ndz, MAX_RANGE);
      let hitBot = null, hitPlayer = null, hitZone = null, hitPos = null;

      for (const b of room.game.bots) {
        if (b.hp <= 0) continue;
        const br = b.radius ?? BOT_RADIUS;
        const res = rayEntityHit(ox, oy, oz, ndx, ndy, ndz, b.pos[0], b.pos[2], br,
          BOT_BODY_LOW, BOT_BODY_HIGH, BOT_HEAD_LOW, BOT_HEAD_HIGH, hitDist);
        if (res && res.t < hitDist) {
          hitDist = res.t; hitBot = b; hitPlayer = null;
          hitZone = res.zone; hitPos = res.pos;
        }
      }

      if (FF_ON) {
        for (const c of room.clients.values()) {
          const op = c.player;
          if (!op || op.id === p.id || op.hp <= 0) continue;
          const res = rayEntityHit(ox, oy, oz, ndx, ndy, ndz, op.pos[0], op.pos[2], PLAYER_RADIUS,
            PLAYER_BODY_LOW, PLAYER_BODY_HIGH, PLAYER_HEAD_LOW, PLAYER_HEAD_HIGH, hitDist);
          if (res && res.t < hitDist) {
            hitDist = res.t; hitPlayer = op; hitBot = null;
            hitZone = res.zone; hitPos = res.pos;
          }
        }
      }

      const endX = ox + ndx * hitDist;
      const endY = oy + ndy * hitDist;
      const endZ = oz + ndz * hitDist;
      room.game.events.push({
        type: "player-shot",
        shooter: clientId, shooterName: p.name,
        from: [ox, oy, oz],
        to: [endX, endY, endZ],
        hit: !!(hitBot || hitPlayer),
      });

      if (hitBot) {
        const isHead = hitZone === "head";
        const beforeHp = hitBot.hp;
        if (isHead) hitBot.hp = 0;
        else hitBot.hp = Math.max(0, hitBot.hp - weaponDamage);
        const dmgDealt = beforeHp - hitBot.hp;

        room.game.events.push({
          type: "hit-bot",
          shooter: clientId, target: hitBot.id, hp: hitBot.hp,
          dmg: dmgDealt, zone: hitZone, pos: hitPos, headshot: isHead,
        });

        if (hitBot.hp <= 0) {
          const bonus = hitBot.boss ? hitBot.tier : 0;
          p.kills += 1 + bonus;
          const victimName = hitBot.boss ? `BOSS Mk.${toRoman(hitBot.tier)}` : "Bot";
          room.game.events.push({
            type: "kill",
            killer: clientId, killerName: p.name,
            victim: hitBot.id, victimName,
            boss: !!hitBot.boss, tier: hitBot.tier || 0,
            headshot: isHead,
          });
        }
      } else if (hitPlayer && now > hitPlayer.invulnUntil) {
        const isHead = hitZone === "head";
        const beforeHp = hitPlayer.hp;
        if (isHead) hitPlayer.hp = 0;
        else hitPlayer.hp = Math.max(0, hitPlayer.hp - weaponDamage);
        const dmgDealt = beforeHp - hitPlayer.hp;

        room.game.events.push({
          type: "hit-player",
          target: hitPlayer.id, hp: hitPlayer.hp, by: clientId,
          dmg: dmgDealt, zone: hitZone, pos: hitPos, headshot: isHead,
        });

        if (hitPlayer.hp <= 0) {
          p.kills--;
          hitPlayer.deaths++;
          hitPlayer.deadUntil = now + RESPAWN_MS;
          room.game.events.push({
            type: "kill",
            killer: clientId, killerName: p.name,
            victim: hitPlayer.id, victimName: hitPlayer.name,
            friendly: true, headshot: isHead,
          });
        }
      }
      return;
    }

    if (msg.type === "avatar") {
      const color = Number(msg.color);
      if (Number.isFinite(color) && color >= 0 && color <= 0xffffff) {
        if (client.player) client.player.color = color | 0;
        else client._pendingColor = color | 0;
      }
      if (msg.melee === "axe" || msg.melee === "knife") {
        if (client.player) client.player.melee = msg.melee;
        else client._pendingMelee = msg.melee;
      }
      return;
    }

    if (msg.type === "grenade" && room.game && client.player) {
      const p = client.player;
      const now = Date.now();
      if (p.hp <= 0) return;
      if (now - p.lastGrenade < GRENADE_COOLDOWN_MS) return;
      p.lastGrenade = now;
      const ox = msg.origin?.[0] ?? p.pos[0];
      const oy = msg.origin?.[1] ?? 1.5;
      const oz = msg.origin?.[2] ?? p.pos[2];
      let dx = msg.dir?.[0] ?? 0, dy = msg.dir?.[1] ?? 0.3, dz = msg.dir?.[2] ?? 0;
      const dlen = Math.hypot(dx, dy, dz);
      if (dlen < 0.01) return;
      dx /= dlen; dy /= dlen; dz /= dlen;
      // Bias upward so it arcs
      const upBias = 0.35;
      dy = Math.max(dy, 0) + upBias;
      const nlen = Math.hypot(dx, dy, dz);
      dx /= nlen; dy /= nlen; dz /= nlen;
      const id = `g${room.game.grenadeCounter++}`;
      room.game.grenades.push({
        id, ownerId: p.id,
        pos: [ox + dx * 0.4, oy + dy * 0.4, oz + dz * 0.4],
        vel: [dx * GRENADE_THROW_SPEED, dy * GRENADE_THROW_SPEED, dz * GRENADE_THROW_SPEED],
        fuseAt: now + GRENADE_FUSE_MS,
        exploded: false,
      });
      room.game.events.push({ type: "grenade-throw", by: p.id, id });
      return;
    }

    if (msg.type === "melee" && room.game && client.player) {
      const p = client.player;
      const now = Date.now();
      if (p.hp <= 0) return;
      const def = MELEE[p.melee] || MELEE[DEFAULT_MELEE];
      if (now - p.lastMelee < def.cooldownMs) return;
      p.lastMelee = now;

      const yaw = (typeof msg.yaw === "number") ? msg.yaw : p.yaw;
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      const range = def.reach;
      const halfArc = def.halfArc;

      let hitBot = null, hitPlayer = null, bestT = Infinity;
      for (const b of room.game.bots) {
        if (b.hp <= 0) continue;
        const r = b.radius ?? BOT_RADIUS;
        const dx = b.pos[0] - p.pos[0], dz = b.pos[2] - p.pos[2];
        const dist = Math.hypot(dx, dz);
        if (dist > range + r) continue;
        const dot = dist > 0 ? (dx * fx + dz * fz) / dist : 1;
        const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
        if (ang > halfArc) continue;
        if (dist < bestT) { bestT = dist; hitBot = b; }
      }
      if (FF_ON) {
        for (const c of room.clients.values()) {
          const op = c.player;
          if (!op || op.id === p.id || op.hp <= 0) continue;
          if (now < op.invulnUntil) continue;
          const dx = op.pos[0] - p.pos[0], dz = op.pos[2] - p.pos[2];
          const dist = Math.hypot(dx, dz);
          if (dist > range + PLAYER_RADIUS) continue;
          const dot = dist > 0 ? (dx * fx + dz * fz) / dist : 1;
          const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
          if (ang > halfArc) continue;
          if (dist < bestT) { bestT = dist; hitPlayer = op; hitBot = null; }
        }
      }

      room.game.events.push({ type: "melee-swing", by: p.id, weapon: p.melee, hit: !!(hitBot || hitPlayer) });

      if (hitBot) {
        hitBot.hp = Math.max(0, hitBot.hp - def.damage);
        if (hitBot.hp <= 0) {
          const bonus = hitBot.boss ? hitBot.tier : 0;
          p.kills += 1 + bonus;
          const victimName = hitBot.boss ? `BOSS Mk.${toRoman(hitBot.tier)}` : "Bot";
          room.game.events.push({ type: "kill", killer: p.id, killerName: p.name, victim: hitBot.id, victimName, boss: !!hitBot.boss, tier: hitBot.tier || 0, melee: true });
        } else {
          room.game.events.push({ type: "hit-bot", shooter: p.id, target: hitBot.id, hp: hitBot.hp });
        }
      } else if (hitPlayer) {
        hitPlayer.hp = Math.max(0, hitPlayer.hp - def.damage);
        if (hitPlayer.hp <= 0) {
          p.kills--;
          hitPlayer.deaths++;
          hitPlayer.deadUntil = now + RESPAWN_MS;
          room.game.events.push({ type: "kill", killer: p.id, killerName: p.name, victim: hitPlayer.id, victimName: hitPlayer.name, friendly: true, melee: true });
        } else {
          room.game.events.push({ type: "hit-player", target: hitPlayer.id, hp: hitPlayer.hp, by: p.id });
        }
      }
      return;
    }

    if (msg.type === "reload" && room.game && client.player) {
      const p = client.player;
      if (p.hp <= 0) return;
      const wdef = WEAPONS[p.weapon] || WEAPONS[DEFAULT_WEAPON];
      const ws = p.weapons[p.weapon];
      if (!ws) return;
      const need = wdef.magSize - ws.ammo;
      const give = Math.min(need, ws.reserve);
      ws.ammo += give;
      ws.reserve -= give;
      return;
    }

    if (msg.type === "weapon-switch" && room.game && client.player) {
      const p = client.player;
      if (p.hp <= 0) return;
      const next = String(msg.weapon || "");
      if (WEAPONS[next] && next !== p.weapon) {
        p.weapon = next;
        // brief switch delay so spam-swap doesn't bypass fire rate
        p.lastFire = Date.now();
      }
      return;
    }
  });

  ws.on("close", () => {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.clients.delete(clientId);
    if (room.clients.size === 0) {
      rooms.delete(roomId);
    } else {
      broadcast(roomId, { type: "peer-left", id: clientId, name, roster: roster(roomId) });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Robot Arena on http://localhost:${PORT}`));
