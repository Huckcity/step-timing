// Pure functions: turn job lists into a comparison and a Markdown report. No I/O here.

export function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const secs = (start, end) => (start && end ? Math.max(0, (Date.parse(end) - Date.parse(start)) / 1000) : null);

export function fmt(s) {
  if (s === null || s === undefined || !Number.isFinite(s)) return '–';
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60), r = Math.round(s - m * 60);
  if (m < 60) return `${m}m ${String(r).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m - h * 60).padStart(2, '0')}m`;
}

function matchesExclude(name, patterns) {
  return patterns.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
}

// jobs: array of GitHub job objects ({name, status, conclusion, started_at, completed_at, steps:[{name,number,status,conclusion,started_at,completed_at}]})
export function summariseRun(jobs, { excludeJobs = [] } = {}) {
  const out = { jobs: new Map(), total: 0, complete: true };
  for (const j of jobs) {
    if (matchesExclude(j.name, excludeJobs)) continue;
    const inProgress = j.status !== 'completed';
    const dur = inProgress ? null : secs(j.started_at, j.completed_at);
    const steps = new Map();
    for (const s of j.steps || []) {
      if (s.status !== 'completed' || !s.started_at || !s.completed_at) continue;
      if (s.conclusion === 'skipped') continue;
      // Steps can repeat names (e.g. several "Run npm test"); disambiguate by order of appearance.
      let key = s.name, i = 2;
      while (steps.has(key)) key = `${s.name} (${i++})`;
      steps.set(key, { seconds: secs(s.started_at, s.completed_at), conclusion: s.conclusion });
    }
    if (dur !== null) out.total += dur; else out.complete = false;
    out.jobs.set(j.name, { seconds: dur, inProgress, conclusion: j.conclusion, steps });
  }
  return out;
}

// current: summariseRun() of this run; baselines: array of summariseRun() for baseline runs
export function compare(current, baselines, { thresholdPercent = 25, thresholdSeconds = 10 } = {}) {
  const flag = (now, base) => {
    if (now === null || base === null || base === undefined) return 'none';
    const delta = now - base;
    if (delta >= thresholdSeconds && base > 0 && delta / base * 100 >= thresholdPercent) return 'slower';
    if (-delta >= thresholdSeconds && base > 0 && -delta / base * 100 >= thresholdPercent) return 'faster';
    return 'same';
  };
  const result = { jobs: [], regressions: 0, improvements: 0, totalNow: current.total, totalBase: median(baselines.filter((b) => b.complete).map((b) => b.total)), baselineCount: baselines.length, complete: current.complete };
  for (const [name, j] of current.jobs) {
    const baseJobs = baselines.map((b) => b.jobs.get(name)).filter(Boolean);
    const baseMed = median(baseJobs.map((b) => b.seconds));
    const jobRow = { name, now: j.seconds, inProgress: j.inProgress, conclusion: j.conclusion, base: baseMed, samples: baseJobs.filter((b) => b.seconds !== null).length, status: flag(j.seconds, baseMed), steps: [] };
    if (jobRow.status === 'slower') result.regressions++; if (jobRow.status === 'faster') result.improvements++;
    for (const [sname, s] of j.steps) {
      const bs = baseJobs.map((b) => b.steps.get(sname)).filter(Boolean);
      const sMed = median(bs.map((b) => b.seconds));
      const row = { name: sname, now: s.seconds, base: sMed, samples: bs.length, status: flag(s.seconds, sMed), conclusion: s.conclusion };
      if (row.status === 'slower') result.regressions++; if (row.status === 'faster') result.improvements++;
      jobRow.steps.push(row);
    }
    result.jobs.push(jobRow);
  }
  result.totalStatus = flag(current.complete ? current.total : null, result.totalBase);
  return result;
}

const ICON = { slower: '🔺', faster: '🔻', same: '', none: '' };
function deltaCell(now, base) {
  if (now === null || base === null || base === undefined) return '–';
  const d = now - base;
  const pct = base > 0 ? Math.round(d / base * 100) : 0;
  const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
  return `${sign}${fmt(Math.abs(d))} (${sign}${Math.abs(pct)}%)`;
}

export function renderMarkdown(cmp, ctx) {
  const { baselineBranch, baselineCount, runUrl, thresholdPercent, thresholdSeconds } = ctx;
  const L = [];
  L.push('<!-- step-timing-report -->');
  L.push('## ⏱ CI step timing');
  if (!baselineCount) {
    L.push(`No completed successful runs of this workflow on \`${baselineBranch}\` yet, so there is nothing to compare against. This run becomes part of the baseline once it is merged.`);
  } else {
    const head = cmp.regressions ? `**${cmp.regressions} regression${cmp.regressions === 1 ? '' : 's'}** against the median of the last ${baselineCount} successful run${baselineCount === 1 ? '' : 's'} on \`${baselineBranch}\`` : `No regressions against the median of the last ${baselineCount} successful run${baselineCount === 1 ? '' : 's'} on \`${baselineBranch}\``;
    L.push(`${head} (flagging ≥ ${thresholdPercent}% and ≥ ${thresholdSeconds}s slower).`);
    if (cmp.complete && cmp.totalBase !== null) L.push(`\nTotal job time: **${fmt(cmp.totalNow)}** vs median ${fmt(cmp.totalBase)} (${deltaCell(cmp.totalNow, cmp.totalBase)}) ${ICON[cmp.totalStatus]}`);
  }
  L.push('');
  L.push('| Job | This run | Baseline median | Change | |');
  L.push('|---|---:|---:|---:|:-:|');
  for (const j of cmp.jobs) {
    const now = j.inProgress ? 'in progress' : fmt(j.now);
    const base = j.samples ? `${fmt(j.base)} (n=${j.samples})` : 'new';
    const name = j.conclusion && j.conclusion !== 'success' && !j.inProgress ? `${j.name} (${j.conclusion})` : j.name;
    L.push(`| ${esc(name)} | ${now} | ${base} | ${deltaCell(j.now, j.base)} | ${ICON[j.status]} |`);
  }
  const flaggedSteps = cmp.jobs.flatMap((j) => j.steps.filter((s) => s.status === 'slower').map((s) => ({ job: j.name, ...s })));
  if (flaggedSteps.length) {
    L.push('', '### Slower steps', '', '| Job | Step | This run | Baseline median | Change |', '|---|---|---:|---:|---:|');
    for (const s of flaggedSteps) L.push(`| ${esc(s.job)} | ${esc(s.name)} | ${fmt(s.now)} | ${fmt(s.base)} (n=${s.samples}) | ${deltaCell(s.now, s.base)} |`);
  }
  for (const j of cmp.jobs) {
    if (!j.steps.length) continue;
    L.push('', `<details><summary>${esc(j.name)}: all steps</summary>`, '', '| Step | This run | Baseline median | Change | |', '|---|---:|---:|---:|:-:|');
    for (const s of j.steps) L.push(`| ${esc(s.name)} | ${fmt(s.now)} | ${s.samples ? fmt(s.base) : 'new'} | ${deltaCell(s.now, s.base)} | ${ICON[s.status]} |`);
    L.push('', '</details>');
  }
  L.push('', `<sub>Generated by <a href="https://github.com/Huckcity/step-timing">CI Step Timing Report</a>${runUrl ? ` for <a href="${runUrl}">this run</a>` : ''}. Medians exclude failed runs; a step is only flagged when it is slower by both thresholds.</sub>`);
  return L.join('\n') + '\n';
}

function esc(s) { return String(s).replace(/\|/g, '\\|').replace(/</g, '&lt;'); }
