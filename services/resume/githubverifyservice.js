const GITHUB_API_BASE_URL = "https://api.github.com";

function buildGithubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "hackbyte-resume-verifier",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  return headers;
}

async function fetchJsonSafely(url) {
  const response = await fetch(url, { headers: buildGithubHeaders() });
  if (!response.ok) return null;
  return response.json();
}

function extractGithubUsername(githubProfile) {
  if (!githubProfile) return null;
  const input = String(githubProfile).trim();
  const urlMatch = input.match(/github\.com\/([A-Za-z0-9_.-]+)/i);
  if (urlMatch) return urlMatch[1];
  if (/^[A-Za-z0-9_.-]+$/.test(input)) return input;
  return null;
}

function tokenize(input) {
  return String(input || "")
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((token) => token.length > 1);
}

function calculateRepoMatch(project, repo) {
  const projectTokens = new Set([
    ...tokenize(project.name),
    ...tokenize(project.description),
    ...(Array.isArray(project.techStack) ? project.techStack.flatMap(tokenize) : []),
  ]);
  const repoTokens = new Set([
    ...tokenize(repo.name),
    ...tokenize(repo.description),
    ...tokenize(repo.language),
    ...(Array.isArray(repo.topics) ? repo.topics.flatMap(tokenize) : []),
  ]);

  if (!projectTokens.size || !repoTokens.size) return 0;

  let overlap = 0;
  for (const token of projectTokens) {
    if (repoTokens.has(token)) overlap += 1;
  }

  return Math.round((overlap / Math.max(projectTokens.size, 1)) * 100);
}

async function verifyGithubProjects({ username, resumeProjects }) {
  const [githubProfile, repos] = await Promise.all([
    fetchJsonSafely(`${GITHUB_API_BASE_URL}/users/${encodeURIComponent(username)}`),
    fetchJsonSafely(`${GITHUB_API_BASE_URL}/users/${encodeURIComponent(username)}/repos?per_page=100&sort=updated`),
  ]);

  if (!githubProfile || !Array.isArray(repos)) {
    throw new Error("Unable to fetch GitHub profile or repositories.");
  }

  const matchedProjects = [];
  for (const project of Array.isArray(resumeProjects) ? resumeProjects : []) {
    let bestRepo = null;
    let bestScore = 0;

    for (const repo of repos) {
      const score = calculateRepoMatch(project, repo);
      if (score > bestScore) {
        bestScore = score;
        bestRepo = repo;
      }
    }

    if (bestRepo && bestScore >= 20) {
      matchedProjects.push({
        resumeProject: project,
        repo: {
          name: bestRepo.name,
          htmlUrl: bestRepo.html_url,
          description: bestRepo.description,
          language: bestRepo.language,
          stars: bestRepo.stargazers_count,
          forks: bestRepo.forks_count,
          pushedAt: bestRepo.pushed_at,
        },
        matchScore: bestScore,
        deploymentCheck: {
          working: Boolean(project.liveUrl),
          url: project.liveUrl || null,
        },
      });
    }
  }

  return {
    githubProfile: {
      login: githubProfile.login,
      name: githubProfile.name,
      followers: githubProfile.followers,
      publicRepos: githubProfile.public_repos,
      profileUrl: githubProfile.html_url,
    },
    matchedProjects,
    geminiAnalysis: { used: false },
  };
}

module.exports = {
  extractGithubUsername,
  verifyGithubProjects,
};
