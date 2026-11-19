/**
 * actions/world.js — Interaction with the world: findBlock, digBlock, placeBlock
 *
 * Based on API:
 *   bot.findBlock(options)              — find nearest block
 *   bot.findBlocks(options)             — find multiple blocks
 *   bot.blockAt(point)                  — get block at coordinates
 *   bot.dig(block, forceLook, digFace)  — dig block
 *   bot.stopDigging()                   — stop digging
 *   bot.canDigBlock(block)              — if bot can dig block
 *   bot.placeBlock(refBlock, faceVec)   — place block
 *   bot.activateBlock(block)            — activate block (open door, etc.)
 */

const vec3 = require('vec3');
const { ensureMovements } = require('./navigation-utils');

/**
 * @param {import('mineflayer').Bot} bot
 */
function createWorldActions(bot) {

  /**
   * Get mcData (lazy initialization)
   */
  let _mcData = null;
  function getMcData() {
    if (!_mcData) _mcData = require('minecraft-data')(bot.version);
    return _mcData;
  }

  return {
    /**
     * Find nearest block by name (read-only, bypassing the queue)
     * @param {{ name: string, maxDistance?: number, count?: number }} params
     */
    findBlock(params) {
      if (!bot) throw new Error('Bot not connected');

      const { name, maxDistance = 32, count = 1 } = params;
      if (!name) throw new Error('Required: name (block name, e.g. "oak_log")');

      const mcData = getMcData();
      const block = mcData.blocksByName[name];
      if (!block) throw new Error(`Unknown block: "${name}"`);

      const positions = bot.findBlocks({
        matching: block.id,
        maxDistance,
        count,
      });

      if (positions.length === 0) {
        return { found: false, count: 0, blocks: [] };
      }

      const blocks = positions.map(pos => {
        const dist = Math.round(pos.distanceTo(bot.entity.position) * 10) / 10;
        return {
          x: pos.x,
          y: pos.y,
          z: pos.z,
          distance: dist,
        };
      });

      return {
        found: true,
        count: blocks.length,
        blocks,
        nearest: blocks[0],
      };
    },

    /**
     * Dig nearest block by name or by coordinates
     * @param {{ name?: string, x?: number, y?: number, z?: number, maxDistance?: number }} params
     * @param {AbortSignal} signal
     */
    async digBlock(params, signal) {
      if (!bot) throw new Error('Bot not connected');

      let targetBlock;

      if (params.x !== undefined && params.y !== undefined && params.z !== undefined) {
        // Dig a specific block by coordinates
        targetBlock = bot.blockAt(vec3(Math.floor(params.x), Math.floor(params.y), Math.floor(params.z)));
        if (!targetBlock || targetBlock.name === 'air') {
          throw new Error(`No block at (${params.x}, ${params.y}, ${params.z})`);
        }
      } else if (params.name) {
        // Search for the nearest block by name
        const mcData = getMcData();
        const blockData = mcData.blocksByName[params.name];
        if (!blockData) throw new Error(`Unknown block: "${params.name}"`);

        const pos = bot.findBlocks({
          matching: blockData.id,
          maxDistance: params.maxDistance || 32,
          count: 1,
        })[0];

        if (!pos) throw new Error(`Block "${params.name}" not found within ${params.maxDistance || 32} blocks`);

        targetBlock = bot.blockAt(pos);
      } else {
        throw new Error('Required: name (block name) or x, y, z coordinates');
      }

      if (!bot.canDigBlock(targetBlock)) {
        throw new Error(`Cannot dig block "${targetBlock.name}" (out of range or not diggable)`);
      }

      // Use pathfinder to approach if the block is far
      const dist = targetBlock.position.distanceTo(bot.entity.position);
      if (dist > 4.5) {
        const { goals: { GoalNear } } = require('mineflayer-pathfinder');
        const { pathfinderGoto } = require('./navigation-utils');
        const { x, y, z } = targetBlock.position;
        await pathfinderGoto(bot, new GoalNear(x, y, z, 3), signal);
      }

      const blockName = targetBlock.name;
      const blockPos = { ...targetBlock.position };
      const digTime = bot.digTime(targetBlock); // Calculate BEFORE digging — block will be destroyed

      const onAbort = () => bot.stopDigging();
      signal?.addEventListener('abort', onAbort, { once: true });

      await bot.dig(targetBlock, true); // forceLook=true
      signal?.removeEventListener('abort', onAbort);

      return {
        dug: true,
        block: blockName,
        position: blockPos,
        digTime,
      };
    },

    /**
     * Activate block (open door, press button, etc.)
     * @param {{ x: number, y: number, z: number }} params
     */
    async activateBlock(params, signal) {
      if (!bot) throw new Error('Bot not connected');

      const { x, y, z } = params;
      if (x === undefined || y === undefined || z === undefined) {
        throw new Error('Required: x, y, z');
      }

      const block = bot.blockAt(vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
      if (!block || block.name === 'air') {
        throw new Error(`No block at (${x}, ${y}, ${z})`);
      }

      await bot.activateBlock(block);

      return {
        activated: true,
        block: block.name,
        position: { x: block.position.x, y: block.position.y, z: block.position.z },
      };
    },

    /**
     * Place block at specified coordinates
     * @param {{ name: string, x: number, y: number, z: number }} params
     */
    async placeBlock(params, signal) {
      if (!bot) throw new Error('Bot not connected');

      const { name, x, y, z } = params;
      const pos = vec3(Math.floor(x), Math.floor(y), Math.floor(z));

      const mcData = getMcData();
      const itemData = mcData.itemsByName[name];
      if (!itemData) throw new Error(`Unknown item: ${name}`);

      const item = bot.inventory.findInventoryItem(itemData.id, null, false);
      if (!item) throw new Error(`Item ${name} not found in inventory`);

      // --- helpers -------------------------------------------------------
      const emptyNames = ['air', 'cave_air', 'void_air', 'short_grass',
        'tall_grass', 'grass', 'dandelion', 'poppy', 'fern', 'dead_bush',
        'snow', 'water'];

      const isEmptyAt = (p) => {
        const b = bot.blockAt(p);
        if (!b) return true;
        return b.boundingBox === 'empty' || emptyNames.includes(b.name);
      };

      const hasLanded = (p) => {
        const b = bot.blockAt(p);
        if (!b) return false;
        if (b.name === name) return true;
        return b.boundingBox === 'block' && b.name.startsWith(name.split('_')[0]);
      };

      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      // --- preconditions -------------------------------------------------
      if (!isEmptyAt(pos)) {
        if (hasLanded(pos)) {
          return { placed: true, name, position: { x: pos.x, y: pos.y, z: pos.z }, note: 'already present' };
        }
        const occupant = bot.blockAt(pos);
        throw new Error(`Target (${pos.x},${pos.y},${pos.z}) is occupied by ${occupant ? occupant.name : 'unknown'}`);
      }

      const bp = bot.entity.position;
      const botX = Math.floor(bp.x);
      const botY = Math.floor(bp.y);
      const botZ = Math.floor(bp.z);
      if (pos.x === botX && pos.z === botZ && (pos.y === botY || pos.y === botY + 1)) {
        throw new Error(`Cannot place block at (${pos.x},${pos.y},${pos.z}) - bot is standing there`);
      }

      // --- approach ------------------------------------------------------
      if (pos.distanceTo(bp) > 4.0) {
        const { goals: { GoalNear } } = require('mineflayer-pathfinder');
        const { pathfinderGoto } = require('./navigation-utils');
        try {
          await pathfinderGoto(bot, new GoalNear(pos.x, pos.y, pos.z, 2), signal);
        } catch (e) {
          // keep going: we may still be within reach
        }
        if (signal?.aborted) throw new Error('Cancelled');
      }

      // --- place, verifying after every attempt --------------------------
      // The original only tried the first solid neighbour and reported
      // success without checking, so failures looked like successes.
      const faces = [
        vec3(0, -1, 0),
        vec3(0, 0, -1),
        vec3(0, 0, 1),
        vec3(-1, 0, 0),
        vec3(1, 0, 0),
        vec3(0, 1, 0),
      ];

      let lastError = null;
      const attempts = 6;

      for (let attempt = 0; attempt < attempts; attempt++) {
        if (signal?.aborted) throw new Error('Cancelled');

        if (hasLanded(pos)) {
          return { placed: true, name, position: { x: pos.x, y: pos.y, z: pos.z }, attempt: attempt + 1 };
        }

        let referenceBlock = null;
        let faceVector = null;
        for (const face of faces) {
          const neighbour = bot.blockAt(pos.plus(face));
          if (neighbour && neighbour.boundingBox === 'block') {
            referenceBlock = neighbour;
            faceVector = face.scaled(-1);
            break;
          }
        }

        if (!referenceBlock) {
          throw new Error(`No solid neighbour to place against at (${pos.x},${pos.y},${pos.z})`);
        }

        try {
          await bot.equip(item, 'hand');
          await bot.lookAt(referenceBlock.position.offset(0.5, 0.5, 0.5), true);
          await sleep(60);
          await bot.placeBlock(referenceBlock, faceVector);
          if (typeof bot.swingArm === 'function') bot.swingArm('right');
          await sleep(250);

          if (hasLanded(pos)) {
            return {
              placed: true,
              name,
              position: { x: pos.x, y: pos.y, z: pos.z },
              against: referenceBlock.name,
              attempt: attempt + 1,
            };
          }
          lastError = new Error(`attempt ${attempt + 1} did not land`);
        } catch (err) {
          lastError = err;
        }

        // rotate the face order so a retry uses a different support
        faces.push(faces.shift());
        await sleep(120);
      }

      throw new Error(
        `Failed to place ${name} at (${pos.x},${pos.y},${pos.z}) after ${attempts} attempts: ` +
        (lastError ? lastError.message : 'unknown reason')
      );
    },

    /**
     * Collect nearest block by name (uses mineflayer-collectblock)
     * @param {{ name: string, count?: number, maxDistance?: number }} params
     */
    async collectBlock(params, signal) {
      if (!bot) throw new Error('Bot not connected');
      if (!bot.collectBlock) throw new Error('collectBlock plugin not loaded');
      if (signal?.aborted) throw new Error('Cancelled');

      ensureMovements(bot);

      const { name, count = 1, maxDistance = 32 } = params;
      if (!name) throw new Error('Required: name (block name, e.g. "oak_log")');

      const mcData = getMcData();
      const blockData = mcData.blocksByName[name];
      if (!blockData) throw new Error(`Unknown block: "${name}"`);

      const positions = bot.findBlocks({
        matching: blockData.id,
        maxDistance,
        count,
      });

      if (positions.length === 0) {
        throw new Error(`Block "${name}" not found within ${maxDistance} blocks`);
      }

      const blocks = positions.map(pos => bot.blockAt(pos));

      // Register abort handler: stop pathfinder so the plugin can react
      const onAbort = () => {
        if (bot.pathfinder) bot.pathfinder.setGoal(null);
        if (typeof bot.stopDigging === 'function') bot.stopDigging();
      };
      signal.addEventListener('abort', onAbort, { once: true });

      try {
        // Explicitly bind method to plugin instance to avoid losing 'this'
        const collect = bot.collectBlock.collect.bind(bot.collectBlock);
        await collect(blocks);
        if (signal.aborted) return { collected: false, reason: 'cancelled' };
        return { collected: true, count: blocks.length, name };
      } catch (err) {
        if (signal.aborted) throw new Error('Cancelled');
        if (err.message === 'Safe to ignore') return { collected: true, name };
        throw err;
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

module.exports = { createWorldActions };
