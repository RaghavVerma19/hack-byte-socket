async function verifyCodeforces(claimedData) {
  const { username, rating, maxRating, rank, maxRank, contestsGiven } = claimedData || {};
  if (!username) {
    return { verified: false, error: "Username not provided" };
  }

  try {
    const [userInfoResponse, ratingResponse] = await Promise.all([
      fetch(`https://codeforces.com/api/user.info?handles=${encodeURIComponent(username)}`),
      fetch(`https://codeforces.com/api/user.rating?handle=${encodeURIComponent(username)}`),
    ]);

    const userInfo = await userInfoResponse.json();
    const ratingInfo = await ratingResponse.json();
    if (userInfo.status !== "OK" || !userInfo.result?.length) {
      return { verified: false, error: "User not found or API error" };
    }

    const profile = userInfo.result[0];
    const contests = Array.isArray(ratingInfo.result) ? ratingInfo.result.length : 0;
    const actual = {
      rating: profile.rating || 0,
      maxRating: profile.maxRating || 0,
      rank: profile.rank || null,
      maxRank: profile.maxRank || null,
      contestsGiven: contests,
    };

    const mismatches = [];
    if (typeof rating === "number" && rating > actual.rating) {
      mismatches.push(`Claimed Codeforces rating (${rating}) is higher than actual (${actual.rating}).`);
    }
    if (typeof maxRating === "number" && maxRating > actual.maxRating) {
      mismatches.push(`Claimed Codeforces max rating (${maxRating}) is higher than actual (${actual.maxRating}).`);
    }
    if (typeof contestsGiven === "number" && contestsGiven > actual.contestsGiven) {
      mismatches.push(`Claimed Codeforces contests (${contestsGiven}) is higher than actual (${actual.contestsGiven}).`);
    }
    if (typeof rank === "string" && actual.rank && rank.toLowerCase() !== actual.rank.toLowerCase()) {
      mismatches.push(`Claimed Codeforces rank (${rank}) does not match actual (${actual.rank}).`);
    }
    if (typeof maxRank === "string" && actual.maxRank && maxRank.toLowerCase() !== actual.maxRank.toLowerCase()) {
      mismatches.push(`Claimed Codeforces max rank (${maxRank}) does not match actual (${actual.maxRank}).`);
    }

    return {
      verified: mismatches.length === 0,
      actual,
      claims: claimedData,
      mismatches,
    };
  } catch (error) {
    return { verified: false, error: error.message };
  }
}

module.exports = {
  verifyCodeforces,
};
