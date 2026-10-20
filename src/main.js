import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { summariseRun, compare, renderMarkdown, fmt } from './report.js';

const input = (name, def = '') => { const v = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`]; return v === undefined || v === '' ? def : v; };
const log = { info: (m) => console.log(m), warn: (m) => console.log(`::warning::${m}`), error: (m) => console.log(`::error::${m}`) };
const setOutput = (k, v) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };

const api = process.env.GITHUB_API_URL || 'https://api.github.com';
const token = input('token', process.env.GITHUB_TOKEN || '');
async function gh(path, opts = {}) {
  const res = await fetch(path.startsWith('http') ? path : `${api}${path}`, {
    ...opts,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'step-timing-action', ...(opts.headers || {}) },
  });
  if (!res.ok) { const body = await res.text().catch(() => ''); const err = new Error(`${opts.method || 'GET'} ${path} → ${res.status} ${body.slice(0, 200)}`); err.status = res.status; throw err; }
  return res.status === 204 ? null : res.json();
}
async function allJobs(repo, runId) {
  const jobs = [];
  for (let page = 1; page < 20; page++) {
    const r = await gh(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}&filter=latest`);
    jobs.push(...r.jobs);
    if (jobs.length >= r.total_count || r.jobs.length === 0) break;
  }
  return jobs;
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!repo || !runId || !token) throw new Error('GITHUB_REPOSITORY, GITHUB_RUN_ID and a token are required (run this inside GitHub Actions).');
  const baselineRuns = Math.max(1, Math.min(50, parseInt(input('baseline-runs', '10'), 10) || 10));
  const thresholdPercent = parseFloat(input('threshold-percent', '25')) || 25;
  const thresholdSeconds = parseFloat(input('threshold-seconds', '10')) || 0;
  const commentOnPr = input('comment-on-pr', 'true') === 'true';
  const failOnRegression = input('fail-on-regression', 'false') === 'true';
  const excludeJobs = input('exclude-jobs', '').split(',').map((s) => s.trim()).filter(Boolean);

  const run = await gh(`/repos/${repo}/actions/runs/${runId}`);
  let baselineBranch = input('baseline-branch', '');
  if (!baselineBranch) baselineBranch = run.repository?.default_branch || (await gh(`/repos/${repo}`)).default_branch;

  const currentJobs = await allJobs(repo, runId);
  // The job running this action is still in progress; its completed steps are still compared.
  const current = summariseRun(currentJobs, { excludeJobs });
  log.info(`This run: ${current.jobs.size} job(s), ${fmt(current.total)} of completed job time${current.complete ? '' : ' (some jobs still in progress)'}.`);

  const list = await gh(`/repos/${repo}/actions/workflows/${run.workflow_id}/runs?branch=${encodeURIComponent(baselineBranch)}&status=success&per_page=${baselineRuns + 1}&exclude_pull_requests=true`);
  const baseRuns = (list.workflow_runs || []).filter((r) => String(r.id) !== String(runId)).slice(0, baselineRuns);
  log.info(`Baseline: ${baseRuns.length} successful run(s) of "${run.name}" on ${baselineBranch}.`);
  const baselines = [];
  for (const r of baseRuns) {
    try { baselines.push(summariseRun(await allJobs(repo, r.id), { excludeJobs })); } catch (e) { log.warn(`Skipping baseline run ${r.id}: ${e.message}`); }
  }

  const cmp = compare(current, baselines, { thresholdPercent, thresholdSeconds });
  const runUrl = run.html_url;
  const md = renderMarkdown(cmp, { baselineBranch, baselineCount: baselines.length, runUrl, thresholdPercent, thresholdSeconds });

  const outDir = process.env.RUNNER_TEMP || '.';
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, 'step-timing-report.md');
  writeFileSync(reportPath, md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  setOutput('regressions', String(cmp.regressions));
  setOutput('total-seconds', String(Math.round(cmp.totalNow)));
  setOutput('baseline-seconds', cmp.totalBase === null ? '' : String(Math.round(cmp.totalBase)));
  setOutput('report-path', reportPath);

  for (const j of cmp.jobs) {
    if (j.status === 'slower') log.warn(`Job "${j.name}" took ${fmt(j.now)} vs median ${fmt(j.base)}.`);
    for (const s of j.steps) if (s.status === 'slower') log.warn(`Step "${s.name}" in "${j.name}" took ${fmt(s.now)} vs median ${fmt(s.base)}.`);
  }

  const prNumber = run.pull_requests?.[0]?.number || (process.env.GITHUB_EVENT_NAME?.startsWith('pull_request') ? Number(process.env.GITHUB_REF?.match(/refs\/pull\/(\d+)/)?.[1]) : null);
  if (commentOnPr && prNumber) {
    try {
      const comments = await gh(`/repos/${repo}/issues/${prNumber}/comments?per_page=100`);
      const mine = comments.find((c) => typeof c.body === 'string' && c.body.includes('<!-- step-timing-report -->'));
      if (mine) await gh(`/repos/${repo}/issues/comments/${mine.id}`, { method: 'PATCH', body: JSON.stringify({ body: md }) });
      else await gh(`/repos/${repo}/issues/${prNumber}/comments`, { method: 'POST', body: JSON.stringify({ body: md }) });
      log.info(`${mine ? 'Updated' : 'Posted'} the report on PR #${prNumber}.`);
    } catch (e) {
      if (e.status === 403 || e.status === 401) log.warn(`Could not comment on PR #${prNumber}: the token needs "pull-requests: write" (add a permissions block to the job). The report is still in the job summary.`);
      else log.warn(`Could not comment on PR #${prNumber}: ${e.message}`);
    }
  }

  if (failOnRegression && cmp.regressions > 0) { log.error(`${cmp.regressions} timing regression(s) beyond ${thresholdPercent}% and ${thresholdSeconds}s.`); process.exitCode = 1; }
}

main().catch((e) => { log.error(e.message); process.exitCode = 1; });
