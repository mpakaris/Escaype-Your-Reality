// src/services/capabilities.js
// Capabilities manager: mount subsystems based on cartridge toggles.

/**
 * Initialize capabilities from the cartridge.
 * @param {object} game - loaded cartridge
 * @returns {Set<string>} enabled capabilities
 */
export function initCapabilities(game) {
  const caps = new Set();
  if (!game?.capabilities) return caps;
  for (const [key, val] of Object.entries(game.capabilities)) {
    if (val) caps.add(key);
  }
  return caps;
}

/**
 * Check if a capability is enabled.
 */
export function hasCapability(state, cap) {
  return state?.capabilities?.has(cap);
}

/**
 * Mount subsystems dynamically. Placeholder for future (combat, currency, etc.).
 * For now, this just records capability set on state.
 */
export function mountCapabilities(state, game) {
  state.capabilities = initCapabilities(game);
}
