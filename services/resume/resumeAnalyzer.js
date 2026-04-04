const { extractResumeData } = require("./resumeExtractor");
const { analyzeAtsScore } = require("./atsAnalyzer");
const { verifyGithubProjects, extractGithubUsername } = require("./githubverifyservice");
const { analyzeCommitsAndContributors } = require("./githubCommitVerifier");
const { analyzeSkillDecay } = require("./githubSkillDecay");
const { generateFinalReview } = require("./reviewGenerator");
const { verifyCodingProfiles } = require("./codingProfilesVerify");

function extractHyperlinksFromText(text) {
  return Array.from(
    new Set(
      (String(text || "").match(/https?:\/\/[^\s)>\]]+/gi) || []).map((link) =>
        link.replace(/[),.;]+$/, ""),
      ),
    ),
  );
}

async function analyzeResumePipeline(pdfBuffer) {
  const extractedDataResult = await extractResumeData(pdfBuffer, []);
  const resumeText = extractedDataResult.rawText;
  const extractedData = extractedDataResult.extractedData || {};
  const pdfLinks = extractHyperlinksFromText(resumeText);
  extractedData._pdfHyperlinks = pdfLinks;

  const atsScorePromise = analyzeAtsScore(resumeText);
  const githubUsername = extractGithubUsername(extractedData.githubProfile);

  const githubAnalytics = { profile: null, matches: [], error: null };
  let skillDecayAnalysis = [];

  if (githubUsername) {
    try {
      const githubResult = await verifyGithubProjects({
        username: githubUsername,
        resumeProjects: Array.isArray(extractedData.projects) ? extractedData.projects : [],
      });

      githubAnalytics.profile = githubResult.githubProfile || null;

      if (Array.isArray(githubResult.matchedProjects)) {
        for (const match of githubResult.matchedProjects) {
          const commitAndCollab = await analyzeCommitsAndContributors(
            githubUsername,
            match.repo.name,
          );

          githubAnalytics.matches.push({
            project: match.resumeProject?.name || match.repo.name,
            repo: match.repo.name,
            repoUrl: match.repo.htmlUrl || null,
            matchScore: match.matchScore,
            deploymentChecked: Boolean(match.deploymentCheck?.working),
            commits: commitAndCollab,
            stars: match.repo.stars || 0,
            language: match.repo.language || null,
            lastPushedAt: match.repo.pushedAt || null,
          });
        }
      }

      skillDecayAnalysis = await analyzeSkillDecay(
        githubUsername,
        Array.isArray(extractedData.skills) ? extractedData.skills : [],
      );
    } catch (error) {
      githubAnalytics.error = error.message;
    }
  } else {
    githubAnalytics.error = "No valid GitHub profile found on resume.";
  }

  const [codingProfilesAnalysis, atsData] = await Promise.all([
    verifyCodingProfiles(extractedData.codingProfiles || {}),
    atsScorePromise,
  ]);

  const verificationReport = {
    candidate: {
      name: extractedData.contactInfo?.name || null,
      email: extractedData.contactInfo?.email || null,
    },
    atsAnalysis: atsData,
    githubAnalytics,
    skillDecay: skillDecayAnalysis,
    codingProfilesVerification: codingProfilesAnalysis,
    internships: extractedData.internships || [],
  };

  verificationReport.finalAutomatedReview = await generateFinalReview(verificationReport);

  return {
    extractedData,
    verificationReport,
  };
}

module.exports = {
  analyzeResumePipeline,
};
