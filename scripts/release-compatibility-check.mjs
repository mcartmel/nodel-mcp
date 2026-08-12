const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const sha = process.env.GITHUB_SHA;
if (!token || !repository || !sha)
  throw new Error("Compatibility gate requires GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_SHA");
const response = await fetch(
  `https://api.github.com/repos/${repository}/actions/workflows/compatibility.yml/runs?head_sha=${sha}&status=completed&per_page=20`,
  {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  },
);
if (!response.ok) throw new Error(`Compatibility workflow lookup failed: HTTP ${response.status}`);
const runs = (await response.json()).workflow_runs ?? [];
const success = runs.find((run) => run.head_sha === sha && run.status === "completed" && run.conclusion === "success");
if (!success) throw new Error(`No successful compatibility run exists for commit ${sha}`);
console.log(`Compatibility gate passed: ${success.html_url}`);
