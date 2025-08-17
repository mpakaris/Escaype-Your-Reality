// src/utils/fuzzyMatch.js
// Lightweight fuzzy matching utilities for commands (enter/talk/search/use)
// All functions are pure and have no side effects.

// --- Normalization ---
export function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-z0-9\s]/g, " ") // keep letters/numbers/spaces
    .replace(/\s+/g, " ")
    .trim();
}

// --- Levenshtein distance (O(mn) with small memory) ---
export function levenshtein(a, b) {
  a = norm(a);
  b = norm(b);
  const m = a.length,
    n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = i - 1; // dp[i-1][j-1]
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1, // deletion
        dp[j - 1] + 1, // insertion
        prev + cost // substitution
      );
      prev = temp;
    }
  }
  return dp[n];
}

// --- Jaro-Winkler similarity (0..1) ---
export function jaroWinkler(a, b) {
  a = norm(a);
  b = norm(b);
  if (a === b) return 1;
  const m = Math.floor(Math.max(a.length, b.length) / 2) - 1;
  const aMatch = new Array(a.length).fill(false);
  const bMatch = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - m);
    const end = Math.min(i + m + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = true;
      bMatch[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let t = 0,
    k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  t /= 2;
  const sim =
    (matches / a.length + matches / b.length + (matches - t) / matches) / 3;
  // Winkler prefix boost
  let l = 0;
  while (l < 4 && a[l] === b[l]) l++;
  return sim + l * 0.1 * (1 - sim);
}

// --- Token/substring biased score mapped to 0..1 ---
export function tokenSimilarity(input, candidate) {
  const A = norm(input),
    B = norm(candidate);
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (B.includes(A))
    return Math.min(0.95, 0.4 + Math.min(A.length * 0.05, 0.45));
  const tokens = B.split(" ");
  let best = 0;
  for (const t of tokens) {
    if (!t) continue;
    if (t.startsWith(A))
      best = Math.max(
        best,
        Math.min(0.8, 0.2 + Math.min(A.length * 0.06, 0.5))
      );
    const d = levenshtein(A, t);
    if (d <= 2) best = Math.max(best, 0.7 - d * 0.1);
  }
  // Blend with Jaro-Winkler for robustness
  const jw = jaroWinkler(A, B);
  return Math.max(best, jw);
}

// --- Main fuzzy match over strings ---
export function fuzzyMatch(
  input,
  candidates,
  { threshold = 0.6, maxResults = 1 } = {}
) {
  const items = (candidates || []).map(String);
  let scored = items.map((c) => ({
    value: c,
    score: tokenSimilarity(input, c),
  }));
  scored.sort((x, y) => y.score - x.score);
  const filtered = scored.filter((s) => s.score >= threshold);
  const results =
    maxResults && maxResults > 0 ? filtered.slice(0, maxResults) : filtered;
  return maxResults === 1 ? results[0] || null : results;
}

// --- Fuzzy pick from objects by one or more fields ---
export function fuzzyPickFromObjects(input, objects, fields, opts = {}) {
  const arr = Array.isArray(objects) ? objects : [];
  const getFields = (o) =>
    (Array.isArray(fields) ? fields : [fields]).map((f) =>
      String(o?.[f] || "")
    );
  const scored = arr.map((o) => {
    const scores = getFields(o).map((v) => tokenSimilarity(input, v));
    const score = Math.max(0, ...scores);
    return { obj: o, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const threshold = opts.threshold ?? 0.6;
  const filtered = scored.filter((s) => s.score >= threshold);
  return opts.maxResults === 1 || opts.maxResults == null
    ? filtered[0] || null
    : filtered.slice(0, opts.maxResults);
}
