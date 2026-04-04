const pdf = require("pdf-parse-new");

function fallbackExtractResumeData(resumeText) {
  const emailMatch = resumeText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)?.[0] || null;
  const githubMatch =
    resumeText.match(/https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+/i)?.[0] || null;
  const linkedinMatch =
    resumeText.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_.-]+/i)?.[0] || null;
  const skillCandidates = [
    "javascript",
    "typescript",
    "react",
    "next.js",
    "node.js",
    "express",
    "mongodb",
    "mysql",
    "postgresql",
    "java",
    "python",
    "c++",
    "docker",
    "aws",
    "redis",
    "tailwind",
  ];

  const loweredText = resumeText.toLowerCase();
  const skills = skillCandidates.filter((skill) => loweredText.includes(skill));

  return {
    contactInfo: {
      name: resumeText.split("\n").find((line) => line.trim().length > 3)?.trim() || null,
      email: emailMatch,
      phone: null,
      location: null,
    },
    githubProfile: githubMatch,
    linkedinProfile: linkedinMatch,
    portfolio: null,
    projects: [],
    internships: [],
    skills,
    codingProfiles: {},
    summary: null,
  };
}

async function extractTextFromPdf(buffer) {
  try {
    const data = await pdf(buffer);
    return data.text;
  } catch (error) {
    const parseError = new Error("Failed to parse PDF document.");
    parseError.statusCode = 400;
    throw parseError;
  }
}

function buildResumeExtractionPrompt(resumeText, hyperlinks = []) {
  const hyperlinkSection = hyperlinks.length
    ? `\n\nHidden PDF hyperlinks:\n${hyperlinks.map((link, index) => `${index + 1}. ${link}`).join("\n")}`
    : "";

  return `
Extract the following resume into strict JSON only.

Schema:
{
  "contactInfo": { "name": string | null, "email": string | null, "phone": string | null, "location": string | null },
  "summary": string | null,
  "githubProfile": string | null,
  "linkedinProfile": string | null,
  "portfolio": string | null,
  "skills": string[],
  "projects": [
    {
      "name": string,
      "description": string | null,
      "techStack": string[],
      "metrics": string[],
      "githubUrl": string | null,
      "liveUrl": string | null
    }
  ],
  "internships": [
    {
      "company": string,
      "role": string | null,
      "duration": string | null,
      "highlights": string[]
    }
  ],
  "codingProfiles": {
    "leetcode": { "username": string | null, "totalSolved": number | null, "ranking": number | null, "easySolved": number | null, "mediumSolved": number | null, "hardSolved": number | null, "currentRating": number | null, "maxRating": number | null, "contestsGiven": number | null } | null,
    "codeforces": { "username": string | null, "rating": number | null, "maxRating": number | null, "rank": string | null, "maxRank": string | null, "contestsGiven": number | null } | null,
    "codechef": { "username": string | null, "currentRating": number | null, "maxRating": number | null, "stars": number | null, "globalRank": number | null, "contestsGiven": number | null } | null
  }
}

Rules:
- Output valid JSON only.
- Prefer explicit evidence from the resume text.
- Use null when unsure.
- Include hidden hyperlinks as high-confidence profile URLs when relevant.

Resume text:
${resumeText}${hyperlinkSection}
  `.trim();
}

async function extractJsonWithGemini(prompt) {
  if (!process.env.GEMINI_API_KEY) {
    return fallbackExtractResumeData(prompt);
  }

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4096,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Gemini extraction request failed with ${response.status}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("Failed to parse Gemini output as JSON.");
  }
}

async function extractResumeData(pdfBuffer, hyperlinks = []) {
  const rawText = await extractTextFromPdf(pdfBuffer);
  const prompt = buildResumeExtractionPrompt(rawText, hyperlinks);
  let extractedData;

  try {
    extractedData = await extractJsonWithGemini(prompt);
  } catch (error) {
    console.error("[resume-extractor] Gemini extraction failed, using fallback:", error.message);
    extractedData = fallbackExtractResumeData(rawText);
  }

  return { rawText, extractedData };
}

module.exports = {
  buildResumeExtractionPrompt,
  extractJsonWithGemini,
  extractResumeData,
  extractTextFromPdf,
};
