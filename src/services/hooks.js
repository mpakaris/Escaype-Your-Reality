// src/services/hooks.js
import { applyEffects } from "./effects.js";

// Generic dispatcher. Applies target[hookName] if it is an effects array.
export async function runEntityHook(ctx, target, hookName) {
  if (!target || !hookName) return;
  const fx = target?.[hookName];
  if (Array.isArray(fx) && fx.length) {
    await applyEffects(ctx, fx, { source: target, hook: hookName });
  }
}

export async function onEnter(ctx, target) {
  return runEntityHook(ctx, target, "onEnter");
}

export async function onExit(ctx, target) {
  return runEntityHook(ctx, target, "onExit");
}

export async function onOpen(ctx, target) {
  return runEntityHook(ctx, target, "onOpen");
}

export async function onTake(ctx, target) {
  return runEntityHook(ctx, target, "onTake");
}

export async function onTalk(ctx, target) {
  return runEntityHook(ctx, target, "onTalk");
}

export async function onChapterComplete(ctx, target) {
  return runEntityHook(ctx, target, "onChapterComplete");
}
