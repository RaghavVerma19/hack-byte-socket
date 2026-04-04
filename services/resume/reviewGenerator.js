async function generateFinalReview(verificationReport) {
  const githubMatches = verificationReport.githubAnalytics?.matches || [];
  const codingProfiles = verificationReport.codingProfilesVerification?.results || {};
  const suspiciousProfiles = Object.values(codingProfiles).filter(
    (result) => result && (result.error || result.mismatches?.length),
  ).length;

  if (process.env.GEMINI_API_KEY) {
    try {
      const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: [
                      "Return JSON only.",
                      'Schema: {"summary":string,"hireSignal":"strong"|"mixed"|"risky","focusAreas":string[]}',
                      "Summarize this resume verification report for a technical interviewer.",
                      JSON.stringify(verificationReport),
                    ].join("\n"),
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 300,
              responseMimeType: "application/json",
            },
          }),
        },
      );

      if (response.ok) {
        const payload = await response.json();
        const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        return JSON.parse(text);
      }
    } catch (error) {
      // Fall back to local summary below.
    }
  }

  const focusAreas = [];
  if (githubMatches.length === 0) focusAreas.push("Ask for a live walkthrough of the strongest project.");
  if (suspiciousProfiles > 0) focusAreas.push("Probe coding-profile claims and recent practice depth.");
  if ((verificationReport.skillDecay || []).some((entry) => entry.decayFlag !== "Active")) {
    focusAreas.push("Check claimed skills against recent hands-on usage.");
  }

  return {
    summary:
      githubMatches.length > 0
        ? "Resume verification found matching GitHub evidence with a few areas worth validating live."
        : "Resume verification found limited public proof, so the interview should emphasize hands-on validation.",
    hireSignal:
      githubMatches.length >= 2 && suspiciousProfiles === 0
        ? "strong"
        : githubMatches.length >= 1
          ? "mixed"
          : "risky",
    focusAreas,
  };
}

module.exports = {
  generateFinalReview,
};
