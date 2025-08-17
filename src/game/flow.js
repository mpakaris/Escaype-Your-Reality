export function beginSequence(state, { type, seq = 0, step = 0 }) {
  state.flow = { active: true, type, seq, step };
}
export function inSequence(state, type = null) {
  if (!state.flow?.active) return false;
  return type ? state.flow.type === type : true;
}
export function advanceStep(state) {
  if (state.flow) state.flow.step += 1;
}
export function advanceSequence(state) {
  if (!state.flow) return;
  state.flow.seq += 1;
  state.flow.step = 0;
}
export function endSequence(state) {
  state.flow = { active: false, type: null, seq: 0, step: 0 };
}
