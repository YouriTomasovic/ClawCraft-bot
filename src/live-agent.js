/**
 * live-agent.js — Continuous behaviour loop for ClawBot
 *
 * The job queue is turn-based: one action at a time, each finishing before the
 * next. That is fine for "dig this block" but wrong for combat and movement,
 * where a real player walks *while* swinging, eats when hurt, and backs off
 * when losing.
 *
 * This module adds three things on top of the queue:
 *
 *   1. INTENT      - a persistent goal ("go here", "attack that") that the bot
 *                    keeps working toward across ticks, instead of a one-shot job
 *   2. REFLEXES    - rules that fire without being asked: eat when hungry, flee
 *                    when low, auto-attack anything hostile that gets close
 *   3. EVENTS      - a small ring buffer of things that happened, so a reader
 *                    can poll one endpoint and see recent changes
 *
 * Everything is opt-in. With intent and reflexes off, the bot behaves exactly
 * as before.
 */

const { goals } = require('mineflayer-pathfinder');

const HOSTILE_MOBS = [
  'zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch',
  'slime', 'magma_cube', 'ghast', 'husk', 'drowned', 'phantom',
  'pillager', 'ravager', 'evoker', 'vindicator', 'silverfish',
  'cave_spider', 'zombified_piglin', 'blaze', 'wither_skeleton',
];

const TICK_MS = 250;

function createLiveAgent(bot, options = {}) {
  const log = options.log || (() => {});
  const maxEvents = options.maxEvents || 200;

  // ─── state ──────────────────────────────────────────────────────────
  const state = {
    intent: null,            // { type: 'goto'|'attack'|'follow', ... }
    reflexes: {
      autoEat: true,         // eat when food low
      autoDefend: false,     // attack hostiles that come close (off by default)
      fleeHealth: 6,         // below this, run toward the player
      defendRadius: 6,       // hostile within this triggers autoDefend
    },
    lastAttackTarget: null,
    lastEatAt: 0,
  };

  const events = [];
  let _tickHandle = null;
  let _lastHealth = 20;
  let _playerName = null;
  let _lastSkip = '';

  // Record why a reflex declined to act. Only logs on change, so a 250ms
  // loop does not spam the console.
  function _skip(reason) {
    if (reason !== _lastSkip) {
      _lastSkip = reason;
      log(`[Live] eat skipped: ${reason}`);
    }
  }

  // ─── events ─────────────────────────────────────────────────────────
  function pushEvent(type, data) {
    events.push({ t: Date.now(), type, ...data });
    if (events.length > maxEvents) events.shift();
  }

  function recentEvents(sinceMs = 30000) {
    const cutoff = Date.now() - sinceMs;
    return events.filter(e => e.t >= cutoff);
  }

  // ─── helpers ────────────────────────────────────────────────────────
  function nearestHostile(radius) {
    if (!bot.entity) return null;
    return bot.nearestEntity((e) => {
      if (!e || !e.isValid) return false;
      const name = (e.name || e.username || '').toLowerCase();
      if (!HOSTILE_MOBS.includes(name)) return false;
      if (Math.abs(e.position.y - bot.entity.position.y) > 8) return false;
      return e.position.distanceTo(bot.entity.position) <= radius;
    });
  }

  function hasFood() {
    return bot.inventory.items().some((it) =>
      ['cooked_beef', 'bread', 'cooked_porkchop', 'cooked_chicken',
        'golden_apple', 'apple', 'carrot', 'baked_potato'].includes(it.name));
  }

  function hasSword() {
    return bot.inventory.items().some((it) => it.name.includes('sword'));
  }

  function playerEntity() {
    if (!_playerName) return null;
    return bot.players[_playerName]?.entity || null;
  }

  // ─── reflexes ───────────────────────────────────────────────────────
  async function eatIfNeeded() {
    if (!state.reflexes.autoEat) { _skip('autoEat off'); return; }
    if (bot.food > 17) { _skip(`food ${bot.food} > 17`); return; }
    if (Date.now() - state.lastEatAt < 3000) { _skip('cooldown'); return; }
    const food = bot.inventory.items().find((it) =>
      ['cooked_beef', 'bread', 'cooked_porkchop', 'cooked_chicken',
        'golden_apple', 'apple', 'baked_potato'].includes(it.name));
    if (!food) { _skip('no food item'); return; }
    try {
      await bot.equip(food, 'hand');
      await bot.consume();
      state.lastEatAt = Date.now();
      pushEvent('eat', { item: food.name, health: bot.health, food: bot.food });
      log(`[Live] ate ${food.name}`);
    } catch (e) {
      log(`[Live] eat failed: ${e.message}`);
    }
  }

  function fleeIfLow() {
    if (bot.health > state.reflexes.fleeHealth) return false;
    const p = playerEntity();
    if (!p) return false;
    if (bot.pvp) { try { bot.pvp.stop(); } catch (_) {} }
    try {
      bot.pathfinder.setGoal(new goals.GoalNear(
        Math.floor(p.position.x), Math.floor(p.position.y), Math.floor(p.position.z), 2));
      pushEvent('flee', { health: bot.health, toward: _playerName });
      return true;
    } catch (_) {
      return false;
    }
  }

  function defendIfNeeded() {
    if (!state.reflexes.autoDefend) return false;
    if (bot.health <= state.reflexes.fleeHealth) return false;
    if (!hasSword()) return false;
    const target = nearestHostile(state.reflexes.defendRadius);
    if (!target) return false;
    if (bot.pvp && bot.pvp.target === target) return false;
    try {
      if (bot.pathfinder) bot.pathfinder.setGoal(null);
      bot.pvp.attack(target);
      state.lastAttackTarget = target;
      pushEvent('engage', {
        mob: target.name,
        distance: Math.round(target.position.distanceTo(bot.entity.position) * 10) / 10,
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  // ─── intent ─────────────────────────────────────────────────────────
  function applyIntent() {
    if (!state.intent) return;
    const i = state.intent;

    if (i.type === 'goto') {
      if (!bot.pathfinder) return;
      if (bot.pvp) { try { bot.pvp.stop(); } catch (_) {} }
      bot.pathfinder.setGoal(new goals.GoalNear(i.x, i.y, i.z, i.radius ?? 1));
      return;
    }

    if (i.type === 'attack') {
      const target = bot.entities[i.id] || bot.nearestEntity((e) => {
        const n = (e.username || e.name || '').toLowerCase();
        return n.includes(String(i.name || '').toLowerCase());
      });
      if (!target || !target.isValid) {
        pushEvent('intent_lost', { reason: 'target gone', name: i.name });
        state.intent = null;
        return;
      }
      if (bot.pvp && bot.pvp.target !== target) {
        bot.pvp.attack(target);
        if (!state.intent._announced) {
          pushEvent('attack_start', { target: target.username || target.name });
          state.intent._announced = true;
        }
      }
      return;
    }

    if (i.type === 'follow') {
      const p = bot.players[i.player]?.entity;
      if (!p) return;
      if (!bot.pathfinder) return;
      bot.pathfinder.setGoal(new goals.GoalFollow(p, i.distance ?? 3), true);
      return;
    }
  }

  // ─── tick ───────────────────────────────────────────────────────────
  async function tick() {
    if (!bot || !bot.entity || bot.health <= 0) return;

    // Death / damage detection
    if (bot.health < _lastHealth) {
      pushEvent('damage', {
        amount: Math.round((_lastHealth - bot.health) * 10) / 10,
        health: Math.round(bot.health * 10) / 10,
      });
    }
    _lastHealth = bot.health;

    // Reflex order matters: survive, then fight, then do what you were told.
    if (fleeIfLow()) return;
    await eatIfNeeded();
    if (defendIfNeeded()) return;
    applyIntent();
  }

  function start() {
    if (_tickHandle) return;
    let _n = 0;
    _tickHandle = setInterval(() => {
      tick().catch((e) => {
        log(`[Live] tick error: ${e.message}`);
        pushEvent('tick_error', { error: e.message });
      });
      // Every 20 ticks (5s) record the state the loop is actually seeing.
      if (++_n % 20 === 0 && bot && bot.entity) {
        pushEvent('_heartbeat', {
          food: bot.food,
          typeofFood: typeof bot.food,
          health: Math.round(bot.health * 10) / 10,
          lastSkip: _lastSkip,
          autoEat: state.reflexes.autoEat,
        });
      }
    }, TICK_MS);
    pushEvent('loop_start', { tickMs: TICK_MS });
    log('[Live] behaviour loop started');
  }

  function stop() {
    if (_tickHandle) {
      clearInterval(_tickHandle);
      _tickHandle = null;
      pushEvent('loop_stop', {});
    }
    if (bot && bot.pvp) { try { bot.pvp.stop(); } catch (_) {} }
    if (bot && bot.pathfinder) { try { bot.pathfinder.setGoal(null); } catch (_) {} }
    state.intent = null;
  }

  // ─── public API ─────────────────────────────────────────────────────
  return {
    start,
    stop,

    /** Set a persistent goal. Replaces any previous intent. */
    setIntent(params) {
      const { type } = params;
      if (!['goto', 'attack', 'follow'].includes(type)) {
        throw new Error('type must be goto, attack, or follow');
      }
      state.intent = { ...params };
      pushEvent('intent', state.intent);
      start();  // ensure the loop is running
      return { intent: state.intent };
    },

    clearIntent() {
      state.intent = null;
      if (bot && bot.pvp) { try { bot.pvp.stop(); } catch (_) {} }
      if (bot && bot.pathfinder) { try { bot.pathfinder.setGoal(null); } catch (_) {} }
      pushEvent('intent_cleared', {});
      return { cleared: true };
    },

    getIntent() {
      return state.intent;
    },

    /** Turn reflexes on or off individually */
    setReflexes(params) {
      Object.assign(state.reflexes, params);
      pushEvent('reflexes', state.reflexes);
      start();  // enabling reflexes must also wake the loop
      return { reflexes: state.reflexes };
    },

    getReflexes() {
      return state.reflexes;
    },

    /** Set which player to flee toward / follow */
    setPlayer(name) {
      _playerName = name;
      return { player: name };
    },

    /** Recent events, newest last */
    getEvents(sinceMs) {
      return { events: recentEvents(sinceMs), count: events.length };
    },

    clearEvents() {
      events.length = 0;
      return { cleared: true };
    },

    isRunning() {
      return _tickHandle !== null;
    },
  };
}

module.exports = { createLiveAgent, HOSTILE_MOBS };
