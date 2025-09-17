/**
 * Lightweight helpers for flags and counters.
 * Import where you mutate state to avoid repeating boilerplate.
 */

export function ensureFlags(state) {
  if (!state || typeof state !== "object") throw new Error("state required");
  if (!state.flags || typeof state.flags !== "object") state.flags = {};
  return state.flags;
}

export function setFlag(state, id, value = true) {
  const flags = ensureFlags(state);
  if (!id || typeof id !== "string") return flags;
  flags[id] = !!value;
  return flags;
}

export function hasFlag(state, id) {
  return !!(state?.flags && state.flags[id]);
}

export function ensureCounters(state) {
  if (!state || typeof state !== "object") throw new Error("state required");
  if (!state.counters || typeof state.counters !== "object")
    state.counters = {};
  return state.counters;
}

export function incCounter(state, id, delta = 1) {
  const counters = ensureCounters(state);
  if (!id || typeof id !== "string") return counters;
  const cur = typeof counters[id] === "number" ? counters[id] : 0;
  counters[id] = cur + (Number.isFinite(delta) ? delta : 1);
  return counters;
}

export function setCounter(state, id, value = 0) {
  const counters = ensureCounters(state);
  if (!id || typeof id !== "string") return counters;
  counters[id] = Number.isFinite(value) ? value : 0;
  return counters;
}
