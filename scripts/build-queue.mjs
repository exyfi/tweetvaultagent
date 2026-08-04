// Turns annotations into the reading queue the Worker serves.
//
// Ordering rules that matter:
//  - priority-1 items first, regardless of goal
//  - then a weighted rotation across goals, so no lane starves
//  - never two posts from the same author back to back
//
// Usage: node scripts/build-queue.mjs annotations.json > queue.json
import { readFileSync } from "node:fs";

const all = JSON.parse(readFileSync(process.argv[2] ?? "data/annotations.example.json", "utf8"));

const money = all.filter((r) => ["launch", "niche"].includes(r.g) && r.n <= 1);
const skill = all.filter((r) => r.g === "skill" && r.n <= 1);
const self = all.filter((r) => r.g === "self" && r.n <= 1);
const news = all.filter((r) => r.g === "news" && r.n <= 1);
// Noisy longreads stay in, in a separate lane: worth understanding how they hook you.
const grift = all.filter((r) => r.n >= 2 && (r.long || r.s >= 6));

const byValue = (a, b) => a.p - b.p || a.n - b.n || b.s - a.s;
[money, skill, self, news, grift].forEach((l) => l.sort(byValue));

const p1 = all.filter((r) => r.p === 1 && r.n <= 1).sort(byValue);
const taken = new Set(p1.map((r) => r.id));
const lanes = [money, skill, self, news, grift].map((l) => l.filter((r) => !taken.has(r.id)));

const WEIGHTS = [3, 3, 2, 1, 1]; // money, skill, self, news, grift per 10 items
const out = [...p1];
let alive = true;
while (alive) {
  alive = false;
  lanes.forEach((lane, i) => {
    for (let k = 0; k < WEIGHTS[i]; k++) {
      const r = lane.shift();
      if (r) { out.push(r); alive = true; }
    }
  });
}

const spaced = [];
const held = [];
for (const r of out) {
  if (spaced.length && spaced[spaced.length - 1].h === r.h) { held.push(r); continue; }
  spaced.push(r);
  for (let i = 0; i < held.length; i++) {
    if (held[i].h !== spaced[spaced.length - 1].h) { spaced.push(held.splice(i, 1)[0]); break; }
  }
}
spaced.push(...held);

process.stdout.write(
  JSON.stringify(spaced.map((r) => ({ i: r.id, g: r.n >= 2 ? "grift" : r.g, n: r.n, h: r.h, t: r.hook.slice(0, 90) }))),
);
