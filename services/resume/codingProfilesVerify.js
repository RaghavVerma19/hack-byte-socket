const { verifyLeetCode } = require("./leetcodeVerify");
const { verifyCodeforces } = require("./codeforcesVerify");
const { verifyCodechef } = require("./codechefVerify");

function normalizeClaim(claim) {
  if (!claim) return null;
  if (typeof claim === "string") return { username: claim };
  if (typeof claim === "object" && claim.username) return claim;
  return null;
}

async function verifyCodingProfiles(codingProfilesClaims) {
  if (!codingProfilesClaims || typeof codingProfilesClaims !== "object") {
    return { verified: true, message: "No coding profiles provided", results: {} };
  }

  const results = {};
  let allVerified = true;

  const leetcodeClaim = normalizeClaim(codingProfilesClaims.leetcode);
  if (leetcodeClaim) {
    results.leetcode = await verifyLeetCode(leetcodeClaim);
    if (results.leetcode.error || results.leetcode.mismatches?.length) allVerified = false;
  }

  const codeforcesClaim = normalizeClaim(codingProfilesClaims.codeforces);
  if (codeforcesClaim) {
    results.codeforces = await verifyCodeforces(codeforcesClaim);
    if (results.codeforces.error || results.codeforces.mismatches?.length) allVerified = false;
  }

  const codechefClaim = normalizeClaim(codingProfilesClaims.codechef);
  if (codechefClaim) {
    results.codechef = await verifyCodechef(codechefClaim);
    if (results.codechef.error || results.codechef.mismatches?.length) allVerified = false;
  }

  return { verified: allVerified, results };
}

module.exports = {
  verifyCodingProfiles,
};
