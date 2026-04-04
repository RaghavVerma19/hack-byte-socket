const cheerio = require("cheerio");

async function verifyCodechef(claimedData) {
  const { username, currentRating, maxRating, stars, globalRank, contestsGiven } =
    claimedData || {};

  if (!username) {
    return { verified: false, error: "Username not provided" };
  }

  try {
    const response = await fetch(`https://www.codechef.com/users/${encodeURIComponent(username)}`);
    if (response.status === 404) {
      return { verified: false, error: "User not found" };
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const actualRatingText = $(".rating-number").text().trim();
    const actualRating = actualRatingText ? parseInt(actualRatingText, 10) : 0;

    const actualStarsText = $(".rating-star").text().trim();
    const actualStarsMatch = actualStarsText.match(/(\d+)/);
    const actualStars = actualStarsMatch ? parseInt(actualStarsMatch[1], 10) : 0;

    const actualGlobalRankText = $(".rating-ranks .inline-list li:first-child a").text().trim();
    const actualGlobalRank = actualGlobalRankText ? parseInt(actualGlobalRankText, 10) : null;

    let actualMaxRating = actualRating;
    const maxRatingText = $("small")
      .filter((_, element) => $(element).text().includes("Highest Rating"))
      .text();
    const maxRatingMatch = maxRatingText.match(/Highest Rating\s+(\d+)/);
    if (maxRatingMatch) {
      actualMaxRating = parseInt(maxRatingMatch[1], 10);
    }

    let actualContestsGiven = null;
    $("h3").each((_, element) => {
      const text = $(element).text();
      if (!text.includes("Contests")) return;
      const count = text.replace(/[^0-9]/g, "");
      if (count) {
        actualContestsGiven = parseInt(count, 10);
      }
    });

    const results = {
      verified: true,
      actual: {
        currentRating: actualRating,
        maxRating: actualMaxRating,
        stars: actualStars,
        globalRank: actualGlobalRank,
        contestsGiven: actualContestsGiven,
      },
      claims: claimedData,
      mismatches: [],
    };

    if (typeof currentRating === "number" && currentRating > actualRating) {
      results.mismatches.push(`Claimed CodeChef rating (${currentRating}) is higher than actual (${actualRating}).`);
    }
    if (typeof maxRating === "number" && maxRating > actualMaxRating) {
      results.mismatches.push(`Claimed max rating (${maxRating}) is higher than actual (${actualMaxRating}).`);
    }
    if (typeof stars === "number" && stars > actualStars) {
      results.mismatches.push(`Claimed stars (${stars}) is higher than actual (${actualStars}).`);
    }
    if (typeof globalRank === "number" && actualGlobalRank && globalRank < actualGlobalRank) {
      results.mismatches.push(`Claimed global rank (${globalRank}) is better than actual (${actualGlobalRank}).`);
    }
    if (typeof contestsGiven === "number" && actualContestsGiven && contestsGiven > actualContestsGiven) {
      results.mismatches.push(`Claimed contests (${contestsGiven}) is higher than actual (${actualContestsGiven}).`);
    }

    results.verified = results.mismatches.length === 0;
    return results;
  } catch (error) {
    return { verified: false, error: error.message };
  }
}

module.exports = {
  verifyCodechef,
};
