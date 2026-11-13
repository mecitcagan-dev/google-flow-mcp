import assert from "node:assert/strict";
import { test } from "node:test";
import { planRun, validateScenes } from "../dist/pool/plan.js";

const scene = (name, seconds = 6) => ({ name, prompt: "p", seconds });
const five = ["a", "b", "c", "d", "e"].map((n) => scene(n));

test("one account that fits everything is preferred, the smallest sufficient one", () => {
  const plan = planRun(five, [
    { id: "x", email: "x@g", credits: 30 },
    { id: "y", email: "y@g", credits: 50 },
    { id: "z", email: "z@g", credits: 80 },
  ]);
  assert.deepEqual(plan.assignments.map((a) => [a.account, a.scenes.length, a.cost]), [["y", 5, 50]]);
  assert.equal(plan.unplaced.length, 0);
});

test("splits over the richest accounts first and keeps scene order", () => {
  const plan = planRun(five, [
    { id: "x", email: "x@g", credits: 20 },
    { id: "y", email: "y@g", credits: 35 },
  ]);
  assert.deepEqual(plan.assignments.map((a) => [a.account, a.scenes.map((s) => s.name).join("")]), [["y", "abc"], ["x", "de"]]);
});

test("profiles sharing one email count once", () => {
  const plan = planRun(five, [
    { id: "e", email: "same@g", credits: 30 },
    { id: "h", email: "SAME@g", credits: 30 },
  ]);
  assert.deepEqual(plan.assignments.map((a) => a.account), ["e"]);
  assert.deepEqual(plan.unplaced.map((s) => s.name), ["d", "e"]);
});

test("unknown emails are not merged, empty accounts are skipped", () => {
  const plan = planRun([scene("a", 4), scene("b", 4)], [
    { id: "p", email: "?", credits: 7 },
    { id: "q", email: "?", credits: 7 },
    { id: "r", email: "r@g", credits: 0 },
  ]);
  assert.deepEqual(plan.assignments.map((a) => a.account), ["p", "q"]);
});

test("scene names are checked before anything is spent", () => {
  assert.throws(() => validateScenes([scene("a/b")]), /file name/);
  assert.throws(() => validateScenes([scene("Hook"), scene("hook")]), /twice/);
  validateScenes([scene("hook_1"), scene("son-2")]);
});
