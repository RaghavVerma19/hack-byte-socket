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

async function analyzeSkillDecay(username, claimedSkills) {
  if (!username || !Array.isArray(claimedSkills) || claimedSkills.length === 0) {
    return [];
  }

  const reposUrl = `${GITHUB_API_BASE_URL}/users/${username}/repos?per_page=100&sort=updated`;
  const repos = await fetchJsonSafely(reposUrl);
  if (!Array.isArray(repos)) return [];

  const latestUsageByLanguage = new Map();

  for (const repo of repos) {
    if (!repo.language) continue;
    const language = String(repo.language).toLowerCase();
    const pushedAt = repo.pushed_at;
    if (!latestUsageByLanguage.has(language)) {
      latestUsageByLanguage.set(language, pushedAt);
      continue;
    }

    const existing = new Date(latestUsageByLanguage.get(language)).getTime();
    const next = new Date(pushedAt).getTime();
    if (next > existing) {
      latestUsageByLanguage.set(language, pushedAt);
    }
  }

  const now = Date.now();
  const msPerMonth = 1000 * 60 * 60 * 24 * 30;

  return claimedSkills.map((skill) => {
    const normalizedSkill = String(skill).toLowerCase();
    let matchedLanguage = null;

    for (const language of latestUsageByLanguage.keys()) {
      if (normalizedSkill.includes(language) || language.includes(normalizedSkill)) {
        matchedLanguage = language;
        break;
      }
    }

    if (!matchedLanguage) {
      return {
        skill,
        lastUsed: null,
        monthsAgo: null,
        decayFlag: `No recent public commits found primarily using ${skill}.`,
      };
    }

    const lastUsed = latestUsageByLanguage.get(matchedLanguage);
    const monthsAgo = Math.floor((now - new Date(lastUsed).getTime()) / msPerMonth);

    return {
      skill,
      lastUsed,
      monthsAgo,
      decayFlag:
        monthsAgo >= 12
          ? `Claims ${skill} experience — last public activity was about ${monthsAgo} months ago.`
          : "Active",
    };
  });
}

module.exports = {
  analyzeSkillDecay,
};
