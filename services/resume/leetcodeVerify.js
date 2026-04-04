async function verifyLeetCode(claimedData) {
  const {
    username,
    totalSolved,
    ranking,
    easySolved,
    mediumSolved,
    hardSolved,
    currentRating,
    maxRating,
    contestsGiven,
  } = claimedData || {};

  if (!username) {
    return { verified: false, error: "Username not provided" };
  }

  try {
    const query = `
      query getUserProfile($username: String!) {
        matchedUser(username: $username) {
          profile { ranking }
          submitStats: submitStatsGlobal { acSubmissionNum { difficulty count } }
        }
        userContestRanking(username: $username) { attendedContestsCount rating }
        userContestRankingHistory(username: $username) { rating }
      }
    `;

    const response = await fetch("https://leetcode.com/graphql/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Referer: "https://leetcode.com",
      },
      body: JSON.stringify({
        query,
        variables: { username },
      }),
    });

    const result = await response.json();
    if (!result.data || (!result.data.matchedUser && !result.data.userContestRanking)) {
      return { verified: false, error: "User not found or API error" };
    }

    const user = result.data.matchedUser;
    const contestData = result.data.userContestRanking || {};
    const historyData = result.data.userContestRankingHistory || [];
    const stats = user?.submitStats?.acSubmissionNum || [];

    let actualTotal = 0;
    let actualEasy = 0;
    let actualMedium = 0;
    let actualHard = 0;

    stats.forEach((stat) => {
      if (stat.difficulty === "All") actualTotal = stat.count;
      if (stat.difficulty === "Easy") actualEasy = stat.count;
      if (stat.difficulty === "Medium") actualMedium = stat.count;
      if (stat.difficulty === "Hard") actualHard = stat.count;
    });

    const actualRanking = user?.profile?.ranking || 0;
    const actualCurrentRating = Math.round(contestData.rating || 0);
    const actualContestsGiven = contestData.attendedContestsCount || 0;
    const historicalRatings = historyData.map((entry) => entry.rating || 0);
    const actualMaxRating = Math.round(
      Math.max(actualCurrentRating, historicalRatings.length ? Math.max(...historicalRatings) : 0),
    );

    const results = {
      verified: true,
      actual: {
        totalSolved: actualTotal,
        ranking: actualRanking,
        easySolved: actualEasy,
        mediumSolved: actualMedium,
        hardSolved: actualHard,
        currentRating: actualCurrentRating,
        maxRating: actualMaxRating,
        contestsGiven: actualContestsGiven,
      },
      claims: claimedData,
      mismatches: [],
    };

    if (typeof totalSolved === "number" && totalSolved > actualTotal) {
      results.mismatches.push(`Claimed total solved (${totalSolved}) is higher than actual (${actualTotal}).`);
    }
    if (typeof ranking === "number" && actualRanking && ranking < actualRanking) {
      results.mismatches.push(`Claimed ranking (${ranking}) is better than actual (${actualRanking}).`);
    }
    if (typeof easySolved === "number" && easySolved > actualEasy) {
      results.mismatches.push(`Claimed easy solved (${easySolved}) is higher than actual (${actualEasy}).`);
    }
    if (typeof mediumSolved === "number" && mediumSolved > actualMedium) {
      results.mismatches.push(`Claimed medium solved (${mediumSolved}) is higher than actual (${actualMedium}).`);
    }
    if (typeof hardSolved === "number" && hardSolved > actualHard) {
      results.mismatches.push(`Claimed hard solved (${hardSolved}) is higher than actual (${actualHard}).`);
    }
    if (typeof currentRating === "number" && currentRating > actualCurrentRating) {
      results.mismatches.push(`Claimed contest rating (${currentRating}) is higher than actual (${actualCurrentRating}).`);
    }
    if (typeof maxRating === "number" && maxRating > actualMaxRating) {
      results.mismatches.push(`Claimed max rating (${maxRating}) is higher than actual (${actualMaxRating}).`);
    }
    if (typeof contestsGiven === "number" && contestsGiven > actualContestsGiven) {
      results.mismatches.push(`Claimed contests (${contestsGiven}) is higher than actual (${actualContestsGiven}).`);
    }

    results.verified = results.mismatches.length === 0;
    return results;
  } catch (error) {
    return { verified: false, error: error.message };
  }
}

module.exports = {
  verifyLeetCode,
};
