// Deterministic PRNG so the mock ABO/CBO type badge stays stable across
// refreshes (same source + same date always produce the same result) but
// genuinely differs day to day and source to source.

export function hashString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

// mulberry32 — small, fast, good-enough distribution for cosmetic mock data
export function seededRng(seedStr) {
  const seedFn = hashString(String(seedStr));
  let a = seedFn();
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rngPick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}
