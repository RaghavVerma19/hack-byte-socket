function analyzeAtsScore(resumeText) {
  const normalized = String(resumeText || "");
  const lowered = normalized.toLowerCase();
  const signals = [
    { key: "experience", points: 10 },
    { key: "project", points: 10 },
    { key: "education", points: 8 },
    { key: "skill", points: 8 },
    { key: "github", points: 8 },
    { key: "linkedin", points: 6 },
    { key: "intern", points: 8 },
    { key: "achievement", points: 6 },
  ];

  let score = 35;
  const matchedSignals = [];
  for (const signal of signals) {
    if (lowered.includes(signal.key)) {
      score += signal.points;
      matchedSignals.push(signal.key);
    }
  }

  const wordCount = normalized.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount >= 250) score += 8;
  if (wordCount >= 450) score += 6;
  if (/@/.test(normalized)) score += 6;
  if (/https?:\/\//i.test(normalized)) score += 5;

  score = Math.max(0, Math.min(score, 100));

  return Promise.resolve({
    score,
    verdict:
      score >= 80 ? "Strong ATS coverage" : score >= 60 ? "Moderate ATS coverage" : "Needs improvement",
    highlights: matchedSignals,
    wordCount,
  });
}

module.exports = {
  analyzeAtsScore,
};
