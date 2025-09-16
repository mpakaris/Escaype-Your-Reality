// Minimal helper to manage per-user revealed items
// Stored as an array of item ids on state.revealedItems

export function getRevealed(state) {
  if (!state.revealedItems || !Array.isArray(state.revealedItems)) {
    state.revealedItems = [];
  }
  return state.revealedItems;
}

export function markRevealed(state, ids) {
  if (!ids) return;
  const arr = getRevealed(state);
  const have = new Set(arr);
  if (Array.isArray(ids)) {
    for (const id of ids) if (id && !have.has(id)) arr.push(id);
  } else if (typeof ids === "string") {
    if (!have.has(ids)) arr.push(ids);
  }
}

export function isRevealed(state, id) {
  if (!id) return false;
  const arr = getRevealed(state);
  return arr.includes(id);
}
