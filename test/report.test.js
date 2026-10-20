import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median, summariseRun, compare, renderMarkdown, fmt } from '../src/report.js';

const t0 = Date.parse('2026-10-20T10:00:00Z');
const iso = (s) => new Date(t0 + s * 1000).toISOString();
function job(name, steps, { status = 'completed', conclusion = 'success' } = {}) {
  let t = 0; const out = [];
  for (const [sname, dur, sc = 'success'] of steps) { out.push({ name: sname, number: out.length + 1, status: 'completed', conclusion: sc, started_at: iso(t), completed_at: iso(t + dur) }); t += dur; }
  return { name, status, conclusion, started_at: iso(0), completed_at: status === 'completed' ? iso(t) : null, steps: out };
}
const baselineRun = (buildSecs) => [job('build', [['Checkout', 5], ['Install', 30], ['Build', buildSecs]]), job('lint', [['Checkout', 5], ['Lint', 20]])];

test('median', () => { assert.equal(median([3, 1, 2]), 2); assert.equal(median([1, 2, 3, 4]), 2.5); assert.equal(median([]), null); });
test('fmt', () => { assert.equal(fmt(5.25), '5.3s'); assert.equal(fmt(65), '1m 05s'); assert.equal(fmt(3700), '1h 01m'); assert.equal(fmt(null), '–'); });

test('flags a slower step and job, ignores small deltas', () => {
  const baselines = [100, 110, 90, 105, 95].map((b) => summariseRun(baselineRun(b)));
  const current = summariseRun([job('build', [['Checkout', 6], ['Install', 31], ['Build', 160]]), job('lint', [['Checkout', 5], ['Lint', 22]])]);
  const cmp = compare(current, baselines, { thresholdPercent: 25, thresholdSeconds: 10 });
  assert.equal(cmp.regressions, 2); // build job + Build step
  const build = cmp.jobs.find((j) => j.name === 'build');
  assert.equal(build.status, 'slower');
  assert.equal(build.steps.find((s) => s.name === 'Build').status, 'slower');
  assert.equal(build.steps.find((s) => s.name === 'Install').status, 'same');
  assert.equal(cmp.jobs.find((j) => j.name === 'lint').status, 'same');
  assert.equal(cmp.totalBase, 160);
  const md = renderMarkdown(cmp, { baselineBranch: 'main', baselineCount: 5, runUrl: 'https://x', thresholdPercent: 25, thresholdSeconds: 10 });
  assert.match(md, /\*\*2 regressions\*\*/);
  assert.match(md, /### Slower steps/);
  assert.match(md, /\| build \| Build \| 2m 40s \| 1m 40s \(n=5\) \| \+1m 00s \(\+60%\) \|/);
});

test('in-progress job compares its completed steps and is not counted in totals', () => {
  const baselines = [summariseRun(baselineRun(100))];
  const current = summariseRun([job('build', [['Checkout', 5], ['Install', 60]], { status: 'in_progress', conclusion: null })]);
  const cmp = compare(current, baselines, {});
  assert.equal(cmp.complete, false);
  assert.equal(cmp.jobs[0].inProgress, true);
  assert.equal(cmp.jobs[0].steps.find((s) => s.name === 'Install').status, 'slower');
  const md = renderMarkdown(cmp, { baselineBranch: 'main', baselineCount: 1, thresholdPercent: 25, thresholdSeconds: 10 });
  assert.match(md, /\| build \| in progress \|/);
});

test('no baseline renders a friendly note; new jobs show as new', () => {
  const current = summariseRun([job('build', [['Checkout', 5]])]);
  const cmp = compare(current, [], {});
  assert.equal(cmp.regressions, 0);
  const md = renderMarkdown(cmp, { baselineBranch: 'main', baselineCount: 0, thresholdPercent: 25, thresholdSeconds: 10 });
  assert.match(md, /nothing to compare against/);
  assert.match(md, /\| build \| 5\.0s \| new \|/);
});

test('exclude-jobs and duplicate step names', () => {
  const current = summariseRun([job('build', [['Run', 5], ['Run', 7]]), job('deploy-prod', [['x', 1]]), job('deploy-stage', [['x', 1]])], { excludeJobs: ['deploy-*'] });
  assert.deepEqual([...current.jobs.keys()], ['build']);
  assert.deepEqual([...current.jobs.get('build').steps.keys()], ['Run', 'Run (2)']);
});

test('skipped steps are ignored and failed baseline jobs still contribute step medians', () => {
  const current = summariseRun([job('build', [['A', 5], ['B', 0, 'skipped']])]);
  assert.deepEqual([...current.jobs.get('build').steps.keys()], ['A']);
});
