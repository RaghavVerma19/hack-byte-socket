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

async function analyzeCommitsAndContributors(owner, repoName) {
  const commitsUrl = `${GITHUB_API_BASE_URL}/repos/${owner}/${repoName}/commits?per_page=15`;
  const contributorsUrl = `${GITHUB_API_BASE_URL}/repos/${owner}/${repoName}/contributors`;

  const [commitsParams, contributorsStats] = await Promise.all([
    fetchJsonSafely(commitsUrl),
    fetchJsonSafely(contributorsUrl),
  ]);

  const result = {
    totalRecentCommits: 0,
    commitMessageQuality: "unknown",
    burstPattern: "unknown",
    collaboratorCount: 0,
    builtAlone: true,
    topContributor: null,
  };

  if (Array.isArray(commitsParams) && commitsParams.length > 0) {
    result.totalRecentCommits = commitsParams.length;
    const messages = commitsParams.map((commit) => commit.commit?.message || "");
    const avgLength = messages.reduce((sum, message) => sum + message.length, 0) / messages.length;

    if (avgLength > 20) result.commitMessageQuality = "good";
    else if (avgLength > 10) result.commitMessageQuality = "average";
    else result.commitMessageQuality = "poor";

    const dates = commitsParams.map((commit) =>
      new Date(commit.commit?.author?.date || Date.now()).toDateString(),
    );
    const uniqueDates = new Set(dates);

    if (uniqueDates.size === 1 && result.totalRecentCommits > 3) {
      result.burstPattern = "high_burst";
    } else if (uniqueDates.size <= 3 && result.totalRecentCommits >= 10) {
      result.burstPattern = "moderate_burst";
    } else {
      result.burstPattern = "healthy_distribution";
    }
  }

  if (Array.isArray(contributorsStats)) {
    result.collaboratorCount = contributorsStats.length;
    result.builtAlone = contributorsStats.length === 1;
    result.topContributor = contributorsStats[0]?.login || null;
  }

  return result;
}

module.exports = {
  analyzeCommitsAndContributors,
};
