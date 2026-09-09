// engine/research/github-reporter.js
// Optional secondary report sink: commits a human-readable Markdown summary
// of each research cycle to a `reports/` folder in this GitHub repo, using
// the GitHub Contents API directly (no extra dependency — Node 18+'s global
// `fetch`, same approach already used by engine/deriv-client.js).
//
// Off by default (RESEARCH_GITHUB_REPORTS=false). Supabase/local JSON
// (engine/research/store.js) remains the primary, queryable record for the
// dashboard; this is a nice-to-have for people who prefer reviewing reports
// as diffs/commits in GitHub instead of (or alongside) a dashboard.
//
// Required env when enabled:
//   RESEARCH_GITHUB_REPORTS=true
//   GITHUB_TOKEN        — a PAT or GitHub App installation token with
//                          `contents:write` on the target repo
//   GITHUB_REPO         — "owner/repo" to commit into (defaults to this repo
//                          if GITHUB_REPOSITORY is set, e.g. by Actions)
//   GITHUB_BRANCH        — branch to commit to (default: repo's default branch)
//   RESEARCH_REPORTS_PATH — folder for reports (default: "reports")

const API_BASE = 'https://api.github.com';

function buildMarkdown({ cycleId, results, generatedAt }) {
  const winners = results.filter((r) => r.isWinner);
  const lines = [];
  lines.push(`# Auto-Researcher Report — ${cycleId}`);
  lines.push('');
  lines.push(`Generated: ${generatedAt}`);
  lines.push('');
  lines.push(`Combos evaluated: **${results.length}** · Winners: **${winners.length}**`);
  lines.push('');
  lines.push('| Symbol | Strategy | TF | SL× | TP× | Grade | Score | OOS WR | OOS PF | Verdict |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');

  const sorted = [...results].sort((a, b) => (b.score || 0) - (a.score || 0));
  for (const r of sorted) {
    const wr = r.oosStats ? `${(r.oosStats.winRate * 100).toFixed(1)}%` : '—';
    const pf = r.oosStats ? (r.oosStats.profitFactor === Infinity ? '∞' : r.oosStats.profitFactor.toFixed(2)) : '—';
    lines.push(`| ${r.symbol} | ${r.strategyId} | ${r.timeframeSeconds}s | ${r.params?.slMultiplier ?? '—'} | ${r.params?.tpMultiplier ?? '—'} | ${r.grade} | ${(r.score || 0).toFixed(1)} | ${wr} | ${pf} | ${r.verdict || ''} |`);
  }

  if (winners.length) {
    lines.push('');
    lines.push('## Suggested tweaks (winners only — apply manually, not auto-applied)');
    for (const w of winners) {
      lines.push('');
      lines.push(`### ${w.symbol} / ${w.strategyId} @ ${w.timeframeSeconds}s`);
      lines.push(`- Params: SL×${w.params.slMultiplier}, TP×${w.params.tpMultiplier}`);
      lines.push(`- Score: ${w.score.toFixed(1)} (${w.grade}) — ${w.verdict}`);
      if (w.warnings?.length) {
        lines.push(`- Warnings: ${w.warnings.join('; ')}`);
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

function resolveRepo(explicit) {
  if (explicit) return explicit;
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY; // "owner/repo", set by GitHub Actions
  return null;
}

async function githubRequest(method, url, token, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 404) {
    throw new Error(`GitHub API ${method} ${url} failed (${res.status}): ${data.message || res.statusText}`);
  }
  return { status: res.status, data };
}

// Commits reports/<path>.md to the repo. Uses PUT contents API — creates the
// file if it doesn't exist (each cycle gets its own file, so no need to
// fetch a `sha` for an update-in-place).
export async function publishReportToGitHub({
  cycleId, results, repo, branch, reportsPath = 'reports',
  token = process.env.GITHUB_TOKEN,
} = {}) {
  const resolvedRepo = resolveRepo(repo);
  if (!token || !resolvedRepo) {
    throw new Error('GITHUB_TOKEN and GITHUB_REPO (or GITHUB_REPOSITORY) must be set to publish reports to GitHub');
  }

  const generatedAt = new Date().toISOString();
  const markdown = buildMarkdown({ cycleId, results, generatedAt });
  const datePrefix = generatedAt.slice(0, 10);
  const filePath = `${reportsPath}/${datePrefix}-${cycleId}.md`;
  const url = `${API_BASE}/repos/${resolvedRepo}/contents/${filePath}`;

  const body = {
    message: `Auto-Researcher report: ${cycleId}`,
    content: Buffer.from(markdown, 'utf8').toString('base64'),
    ...(branch ? { branch } : {}),
  };

  const { data } = await githubRequest('PUT', url, token, body);
  return { path: filePath, htmlUrl: data.content?.html_url || null };
}
