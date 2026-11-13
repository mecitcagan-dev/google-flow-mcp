// Pure planning: which account makes which scene. No browser, no disk, so it is tested on its own.

// Omni 1.1 Flash at 720p, credits per clip length in seconds (measured in Flow's own quotes).
export const COST: Record<number, number> = { 4: 7, 6: 10, 8: 12, 10: 15 };

export type Scene = { name: string; prompt: string; seconds: 4 | 6 | 8 | 10 };
export type Balance = { id: string; email: string; credits: number };
export type Assignment = { account: string; scenes: Scene[]; cost: number };

export const costOf = (s: Scene): number => COST[s.seconds];

// Scene names become file names, so they are checked before anything is spent.
export function validateScenes(scenes: Scene[]): void {
  const seen = new Set<string>();
  for (const s of scenes) {
    if (!/^[\w-]{1,60}$/.test(s.name)) throw new Error(`Scene name "${s.name}" must be 1-60 letters, digits, "_" or "-": it becomes the file name.`);
    if (seen.has(s.name.toLowerCase())) throw new Error(`Scene name "${s.name}" is used twice; names must be unique in one call.`);
    seen.add(s.name.toLowerCase());
  }
}

// One account that fits everything is preferred: a character drawn in one account looks the same in every clip, and
// the smallest balance that fits is used so large balances stay whole for large jobs. Otherwise the richest accounts
// are filled first, keeping scene order. Profiles signed in to the same Google account share one balance and count once.
export function planRun(scenes: Scene[], balances: Balance[]): { assignments: Assignment[]; unplaced: Scene[] } {
  const seen = new Set<string>();
  const unique = balances.filter((b) => {
    const key = b.email && b.email !== "?" ? b.email.toLowerCase() : `id:${b.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return b.credits > 0;
  });
  const total = scenes.reduce((n, s) => n + costOf(s), 0);
  const single = unique.filter((b) => b.credits >= total).sort((a, b) => a.credits - b.credits)[0];
  if (single && scenes.length) return { assignments: [{ account: single.id, scenes, cost: total }], unplaced: [] };

  const assignments: Assignment[] = [];
  let i = 0;
  for (const b of [...unique].sort((a, c) => c.credits - a.credits)) {
    let left = b.credits;
    const mine: Scene[] = [];
    while (i < scenes.length && left >= costOf(scenes[i])) {
      left -= costOf(scenes[i]);
      mine.push(scenes[i++]);
    }
    if (mine.length) assignments.push({ account: b.id, scenes: mine, cost: b.credits - left });
    if (i === scenes.length) break;
  }
  return { assignments, unplaced: scenes.slice(i) };
}
