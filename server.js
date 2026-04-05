require("dotenv").config();

const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const twilio = require("twilio");
const { execFile } = require("child_process");
const { Server } = require("socket.io");
const { analyzeResumePipeline } = require("./services/resume/resumeAnalyzer");
const { extractResumeData } = require("./services/resume/resumeExtractor");
const { analyzeAtsScore } = require("./services/resume/atsAnalyzer");
const { verifyGithubProjects, verifyGithubProfile, extractGithubUsername } = require("./services/resume/githubverifyservice");
const { analyzeCommitsAndContributors } = require("./services/resume/githubCommitVerifier");
const { analyzeSkillDecay } = require("./services/resume/githubSkillDecay");
const { verifyCodingProfiles } = require("./services/resume/codingProfilesVerify");
const { verifyLeetCode } = require("./services/resume/leetcodeVerify");
const { verifyCodeforces } = require("./services/resume/codeforcesVerify");
const { verifyCodechef } = require("./services/resume/codechefVerify");
const { generateFinalReview } = require("./services/resume/reviewGenerator");

const USERS_FILE = path.join(__dirname, "data", "users.json");
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const JWT_SECRET = process.env.JWT_SECRET || "hackbyte-dev-secret";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const SPACETIME_CLI_PATH =
  process.env.SPACETIME_CLI_PATH ||
  "C:\\Users\\DELL\\AppData\\Local\\SpacetimeDB\\spacetime.exe";
const AUTH_WINDOW_MS = Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const AUTH_MAX_REQUESTS = Number(process.env.AUTH_RATE_LIMIT_MAX_REQUESTS || 20);
const TWILIO_NTS_TTL = Number(process.env.TWILIO_NTS_TTL || 3600);
const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{3,120}$/;
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || "nova-2";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const AI_TRANSCRIPT_MIN_WORDS = Number(process.env.AI_TRANSCRIPT_MIN_WORDS || 1);
const AI_ANALYSIS_MIN_WORDS = Number(process.env.AI_ANALYSIS_MIN_WORDS || 4);
const AI_MAX_SEGMENTS = Number(process.env.AI_MAX_SEGMENTS || 6);
const AI_MAX_HISTORY = Number(process.env.AI_MAX_HISTORY || 8);
const AI_DISPLAY_TRANSCRIPT_HISTORY = Number(process.env.AI_DISPLAY_TRANSCRIPT_HISTORY || 80);
const AI_ANALYSIS_DEBOUNCE_MS = Number(process.env.AI_ANALYSIS_DEBOUNCE_MS || 35000);
const AI_PARAGRAPH_MIN_WORDS = Number(process.env.AI_PARAGRAPH_MIN_WORDS || 60);
const AI_PARAGRAPH_SOFT_MIN_WORDS = Number(process.env.AI_PARAGRAPH_SOFT_MIN_WORDS || 8);
const AI_PARAGRAPH_FLUSH_MS = Number(process.env.AI_PARAGRAPH_FLUSH_MS || 5000);
const authRateLimiter = new Map();
const aiInterviewState = new Map();
const eyeAnalysisState = new Map();

function failFast(message) {
  throw new Error(message);
}

function assertProductionConfig() {
  if (!IS_PRODUCTION) return;

  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === "hackbyte-dev-secret") {
    failFast("JWT_SECRET must be set to a strong value in production.");
  }

  if (!process.env.CLIENT_URLS && !process.env.CLIENT_URL) {
    failFast("CLIENT_URL or CLIENT_URLS must be set in production.");
  }

  if ((process.env.CLIENT_URLS || process.env.CLIENT_URL || "").trim() === "*") {
    failFast("Wildcard CORS is not allowed in production.");
  }
}

function ensureUsersFile() {
  const directory = path.dirname(USERS_FILE);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, "[]\n");
  }
}

function parseAllowedOrigins() {
  const rawOrigins = process.env.CLIENT_URLS || process.env.CLIENT_URL || "*";
  if (rawOrigins === "*") return "*";
  return rawOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function applyCorsHeaders(req, res, allowedOrigins) {
  const requestOrigin = req.headers.origin;
  const allowAnyOrigin = allowedOrigins === "*";
  const isAllowedOrigin =
    allowAnyOrigin || (requestOrigin && allowedOrigins.includes(requestOrigin));

  if (allowAnyOrigin) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (isAllowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (IS_PRODUCTION) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload",
    );
  }
}

function getClientAddress(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function authLimiter(req, res, next) {
  const key = getClientAddress(req);
  const now = Date.now();
  const bucket = authRateLimiter.get(key);

  if (!bucket || now > bucket.resetAt) {
    authRateLimiter.set(key, { count: 1, resetAt: now + AUTH_WINDOW_MS });
    next();
    return;
  }

  if (bucket.count >= AUTH_MAX_REQUESTS) {
    res.status(429).json({
      ok: false,
      message: "Too many authentication attempts. Please try again later.",
    });
    return;
  }

  bucket.count += 1;
  next();
}

function normalizeRole(role) {
  return role === "candidate" || role === "interviewer" ? role : null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function countWords(input) {
  return String(input || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function compactWhitespace(input) {
  return String(input || "").replace(/\s+/g, " ").trim();
}

function parseGeminiJsonPayload(rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {}

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    try {
      return JSON.parse(fencedMatch[1]);
    } catch {}
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch?.[0]) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {}
  }

  throw new Error("Gemini returned a non-JSON scoring payload.");
}

function pushTranscriptHistory(state, text) {
  const normalizedTranscript = compactWhitespace(text);
  if (!normalizedTranscript) {
    return false;
  }

  const previousEntry = state.transcriptHistory[state.transcriptHistory.length - 1];
  if (previousEntry?.text === normalizedTranscript) {
    return false;
  }

  state.transcriptHistory.push({
    text: normalizedTranscript,
    createdAt: Date.now(),
  });
  if (state.transcriptHistory.length > AI_DISPLAY_TRANSCRIPT_HISTORY) {
    state.transcriptHistory.shift();
  }

  return true;
}

function getConfidence(score, eventCount) {
  if (eventCount < 10) {
    return "low";
  }

  const distanceFromThreshold = Math.abs(score - 60);
  if (distanceFromThreshold >= 18 && eventCount >= 18) {
    return "high";
  }

  return "medium";
}

function buildEmptyEyeSnapshot() {
  return {
    isCheating: false,
    cheatingScore: 0,
    isTypewriterMovement: false,
    typewriterScore: 0,
    confidence: "idle",
    summary: "Waiting for candidate eye-movement data.",
    reason: "No analysis window received yet.",
    recommendation: "Keep monitoring the candidate feed.",
    eventCount: 0,
    lastUpdatedAt: null,
    history: [],
  };
}

function getOrCreateEyeState(roomId) {
  if (!eyeAnalysisState.has(roomId)) {
    eyeAnalysisState.set(roomId, {
      latest: buildEmptyEyeSnapshot(),
      history: [],
    });
  }

  return eyeAnalysisState.get(roomId);
}

function clearEyeState(roomId) {
  eyeAnalysisState.delete(roomId);
}

function buildEmptyAiSnapshot() {
  return {
    aiLikelihood: null,
    confidence: "idle",
    samplesAnalyzed: 0,
    chunkCount: 0,
    transcriptCount: 0,
    updatedAt: null,
    status: "idle",
    detail: "Waiting for candidate speech.",
    transcriptMode: "waiting",
  };
}

function getOrCreateAiState(roomId) {
  if (!aiInterviewState.has(roomId)) {
    aiInterviewState.set(roomId, {
      roomId,
      transcriptSegments: [],
      transcriptHistory: [],
      scoreHistory: [],
      chunkCount: 0,
      rollingAiLikelihood: null,
      confidence: "idle",
      updatedAt: null,
      status: aiReview?.isScoringEnabled?.() ? "listening" : "scoring_disabled",
      detail: aiReview?.isScoringEnabled?.()
        ? "Listening for candidate speech."
        : "Gemini is not configured on the backend.",
      transcriptMode: "waiting",
      liveDraft: "",
      pendingParagraph: "",
      paragraphTimer: null,
      analysisTimer: null,
      analysisPromise: Promise.resolve(),
    });
  }

  return aiInterviewState.get(roomId);
}

function clearAiState(roomId) {
  const state = aiInterviewState.get(roomId);
  if (state?.analysisTimer) {
    clearTimeout(state.analysisTimer);
  }
  if (state?.paragraphTimer) {
    clearTimeout(state.paragraphTimer);
  }
  aiInterviewState.delete(roomId);
}

function getAiSnapshot(roomId) {
  const state = aiInterviewState.get(roomId);
  if (!state) {
    const snapshot = buildEmptyAiSnapshot();
    if (!aiReview.isScoringEnabled()) {
      snapshot.status = "scoring_disabled";
      snapshot.detail = "Gemini is not configured on the backend.";
    }
    return snapshot;
  }

  return {
    aiLikelihood: state.rollingAiLikelihood,
    confidence: state.confidence,
    samplesAnalyzed: state.scoreHistory.length,
    chunkCount: state.chunkCount,
    transcriptCount: state.transcriptHistory.length,
    updatedAt: state.updatedAt,
    status: state.status,
    detail: state.detail,
    transcriptMode: state.transcriptMode,
    bufferWordCount: countWords(state.pendingParagraph),
    bufferThreshold: AI_PARAGRAPH_MIN_WORDS,
  };
}

function hasSpacetimeConfig() {
  return Boolean(process.env.SPACETIMEDB_ENABLED === "true" && process.env.SPACETIMEDB_DB_NAME);
}

function readUsers() {
  ensureUsersFile();
  if (!fs.existsSync(USERS_FILE)) {
    return [];
  }

  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function sanitizeUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
  };
}

function createToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function serializeReducerArgs(payload) {
  const values = Array.isArray(payload) ? payload : Object.values(payload);
  return values.map((value) => JSON.stringify(value ?? null));
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isStrongEnoughPassword(password) {
  return password.length >= 8;
}

function isValidRoomId(roomId) {
  return ROOM_ID_PATTERN.test(roomId);
}

function createTwilioIceService() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID || "";
  const authToken = process.env.TWILIO_AUTH_TOKEN || "";
  const apiKey = process.env.TWILIO_API_KEY || "";
  const apiSecret = process.env.TWILIO_API_SECRET || "";
  const useApiKey = Boolean(accountSid && apiKey && apiSecret);
  const useAuthToken = Boolean(accountSid && authToken);
  const enabled = useApiKey || useAuthToken;
  const client = useApiKey
    ? twilio(apiKey, apiSecret, { accountSid })
    : useAuthToken
      ? twilio(accountSid, authToken)
      : null;

  return {
    isEnabled() {
      return enabled;
    },
    async getIceServers() {
      if (!enabled || !client) {
        return [{ urls: "stun:stun.l.google.com:19302" }];
      }

      const token = await client.tokens.create({ ttl: TWILIO_NTS_TTL });
      return token.iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }];
    },
  };
}

function createSpacetimeClient() {
  const enabled = hasSpacetimeConfig();
  const databaseName = process.env.SPACETIMEDB_DB_NAME || "";
  const serverUrl = process.env.SPACETIMEDB_SERVER_URL || "";
  let queue = Promise.resolve();

  function runReducer(reducerName, payload) {
    return new Promise((resolve, reject) => {
      const args = ["call", "-y"];
      if (serverUrl) args.push("--server", serverUrl);
      args.push(databaseName, reducerName, ...serializeReducerArgs(payload));

      execFile(SPACETIME_CLI_PATH, args, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || stdout || error.message));
          return;
        }
        resolve(stdout);
      });
    });
  }

  function enqueue(reducerName, payload) {
    queue = queue
      .then(() => runReducer(reducerName, payload))
      .catch((error) => {
        console.error(`[spacetimedb] ${reducerName} failed`, error.message);
      });
    return queue;
  }

  return {
    getStatus() {
      return {
        enabled,
        databaseName: databaseName || null,
        serverUrl: serverUrl || null,
      };
    },
    syncRoomSnapshot(roomId, state, participants) {
      if (!enabled) return Promise.resolve();

      enqueue("sync_room", {
        room_id: roomId,
        interview_started: state.interviewStarted,
        has_candidate: state.hasCandidate,
        has_interviewer: state.hasInterviewer,
        share_requirement_met: state.shareRequirementMet,
        active_share_peer_id: state.activeSharePeerId,
        active_share_role: state.activeShareRole,
        active_share_surface: state.activeShareSurface,
        waiting_for: state.waitingFor,
        updated_at: Date.now(),
      });

      participants.forEach((participant) => {
        enqueue("upsert_participant", {
          room_id: roomId,
          peer_id: participant.peerId,
          name: participant.name,
          role: participant.role,
          muted: participant.muted,
          camera_off: participant.cameraOff,
          share_active: participant.shareActive,
          display_surface: participant.displaySurface,
          joined_at: participant.joinedAt || Date.now(),
          updated_at: Date.now(),
        });
      });

      return queue;
    },
    appendUser(user) {
      if (!enabled) return Promise.resolve();
      enqueue("upsert_user", {
        user_id: user.id,
        email: user.email,
        role: user.role,
        password_hash: user.passwordHash,
        created_at: user.createdAt,
        updated_at: Date.now(),
      });
      return queue;
    },
    appendAuthEvent(type, payload) {
      if (!enabled) return Promise.resolve();
      enqueue("append_auth_event", {
        event_type: type,
        payload: JSON.stringify(payload),
        created_at: Date.now(),
      });
      return queue;
    },
    removeParticipant(roomId, peerId) {
      if (!enabled) return Promise.resolve();
      enqueue("remove_participant", { room_id: roomId, peer_id: peerId });
      return queue;
    },
    appendRoomEvent(roomId, type, payload) {
      if (!enabled) return Promise.resolve();
      enqueue("append_room_event", {
        room_id: roomId,
        event_type: type,
        payload: JSON.stringify(payload),
        created_at: Date.now(),
      });
      return queue;
    },
  };
}

function createAiReviewService() {
  const deepgramApiKey = process.env.DEEPGRAM_API_KEY || "";
  const geminiApiKey = process.env.GEMINI_API_KEY || "";

  return {
    isTranscriptionEnabled() {
      return Boolean(deepgramApiKey);
    },
    isScoringEnabled() {
      return Boolean(geminiApiKey);
    },
    async transcribeChunk(audioBuffer, mimeType) {
      if (!deepgramApiKey || !audioBuffer?.length) {
        return "";
      }

      const normalizedMimeType =
        typeof mimeType === "string" && mimeType.includes("ogg")
          ? "audio/ogg"
          : "audio/webm";

      const response = await fetch(
        `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(
          DEEPGRAM_MODEL,
        )}&smart_format=true&punctuate=true`,
        {
          method: "POST",
          headers: {
            Authorization: `Token ${deepgramApiKey}`,
            "Content-Type": normalizedMimeType,
          },
          body: audioBuffer,
        },
      );

      if (!response.ok) {
        throw new Error(`Deepgram request failed with ${response.status}`);
      }

      const payload = await response.json();
      return compactWhitespace(
        payload?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "",
      );
    },
    async scoreTranscript(recentTranscript, rollingContext) {
      const transcript = compactWhitespace(recentTranscript);
      if (!geminiApiKey || !transcript) {
        return {
          aiLikelihood: 0,
          confidence: "idle",
        };
      }

      const prompt = [
        "Return JSON only.",
        'Schema: {"aiLikelihood":number,"confidence":"low"|"medium"|"high"}',
        "Task: estimate how likely this spoken interview answer sounds AI-generated.",
        "Score natural hesitations, specificity, imperfection, and spoken cadence as more human.",
        "Do not explain. Use the transcript only.",
        rollingContext ? `Recent prior context: ${rollingContext}` : "",
        `Transcript: ${transcript}`,
      ]
        .filter(Boolean)
        .join("\n");

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          GEMINI_MODEL,
        )}:generateContent?key=${encodeURIComponent(geminiApiKey)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.1,
              topP: 0.8,
              maxOutputTokens: 40,
              responseMimeType: "application/json",
            },
          }),
        },
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Gemini request failed with ${response.status}: ${errorBody.slice(0, 200)}`);
      }

      const payload = await response.json();
      const parts = payload?.candidates?.[0]?.content?.parts;
      const text = Array.isArray(parts)
        ? parts
            .map((part) => (typeof part?.text === "string" ? part.text : ""))
            .join("\n")
        : "{}";
      const parsed = parseGeminiJsonPayload(text);

      return {
        aiLikelihood: clamp(Number(parsed?.aiLikelihood) || 0, 0, 100),
        confidence:
          parsed?.confidence === "low" ||
          parsed?.confidence === "medium" ||
          parsed?.confidence === "high"
            ? parsed.confidence
            : "medium",
      };
    },
  };
}

function analyzeEyeEventsHeuristically(movementEvents, phase) {
  const pattern = movementEvents.map((event) => event.direction).join("");
  const total = movementEvents.length;

  if (phase !== "ANSWER") {
    return {
      isCheating: false,
      cheatingScore: 0,
      isTypewriterMovement: false,
      typewriterScore: 0,
      confidence: "high",
      summary: `Pattern ignored because phase is ${phase}.`,
      reason: "Candidate is not actively answering a question.",
      recommendation: "Wait for candidate to begin answering.",
      pattern,
      eventCount: total,
    };
  }

  if (total < 14) {
    return {
      isCheating: false,
      cheatingScore: 0,
      isTypewriterMovement: false,
      typewriterScore: 0,
      confidence: "low",
      summary: "Not enough eye movement data.",
      reason: `Only ${total} events recorded in this window.`,
      recommendation: "Continue monitoring.",
      pattern,
      eventCount: total,
    };
  }

  const rightCount = movementEvents.filter((event) => event.direction === "R").length;
  const leftCount = total - rightCount;
  let transitions = 0;
  let rapidTransitions = 0;
  let maxRStreak = 0;
  let maxLStreak = 0;
  let currentStreak = 1;
  let currentDir = movementEvents[0].direction;
  const streaks = [];

  for (let index = 1; index < total; index += 1) {
    const current = movementEvents[index];
    const prev = movementEvents[index - 1];

    if (current.direction === currentDir) {
      currentStreak += 1;
    } else {
      streaks.push({ direction: currentDir, length: currentStreak });
      if (currentDir === "R") maxRStreak = Math.max(maxRStreak, currentStreak);
      if (currentDir === "L") maxLStreak = Math.max(maxLStreak, currentStreak);
      currentDir = current.direction;
      currentStreak = 1;
    }

    if (current.direction !== prev.direction) {
      transitions += 1;

      if (current.timestamp && prev.timestamp) {
        const gapMs = new Date(current.timestamp).getTime() - new Date(prev.timestamp).getTime();
        if (gapMs <= 2000) {
          rapidTransitions += 1;
        }
      } else {
        rapidTransitions += 1;
      }
    }
  }

  streaks.push({ direction: currentDir, length: currentStreak });
  if (currentDir === "R") maxRStreak = Math.max(maxRStreak, currentStreak);
  if (currentDir === "L") maxLStreak = Math.max(maxLStreak, currentStreak);

  const alternationRate = rapidTransitions / Math.max(total - 1, 1);
  const rightBias = rightCount / total;
  const sideBalanceScore = clamp(1 - Math.abs(rightBias - 0.5) * 1.7, 0, 1);
  const maxStreak = Math.max(maxRStreak, maxLStreak);

  let lineSweepCycles = 0;
  let longSweepStreaks = 0;
  let shortResetStreaks = 0;
  let dartingPenalty = 0;

  streaks.forEach((streak) => {
    if (streak.length >= 3) {
      longSweepStreaks += 1;
    }
    if (streak.length <= 2) {
      shortResetStreaks += 1;
    }
  });

  for (let index = 0; index < streaks.length - 1; index += 1) {
    const current = streaks[index];
    const next = streaks[index + 1];
    const isReadingCycle =
      current.direction !== next.direction &&
      current.length >= 3 &&
      next.length >= 1 &&
      next.length <= Math.max(3, current.length - 1);

    if (isReadingCycle) {
      lineSweepCycles += 1;
    }
  }

  if (alternationRate > 0.45 && maxStreak <= 2) {
    dartingPenalty = clamp((alternationRate - 0.45) / 0.35, 0, 1);
  }

  const cycleScore = clamp(lineSweepCycles / 5, 0, 1);
  const structuredSweepScore =
    streaks.length > 0 ? clamp(longSweepStreaks / streaks.length, 0, 1) : 0;
  const resetDisciplineScore =
    streaks.length > 0 ? clamp(shortResetStreaks / streaks.length, 0, 1) : 0;
  const eventDensity = clamp((total - 10) / 28, 0, 1);
  const compositeScore =
    cycleScore * 42 +
    structuredSweepScore * 23 +
    sideBalanceScore * 15 +
    resetDisciplineScore * 12 +
    eventDensity * 8 -
    dartingPenalty * 28;

  const cheatingScore = clamp(Math.round(compositeScore), 0, 100);
  const isCheating = cheatingScore >= 68 && lineSweepCycles >= 3 && maxStreak >= 3;
  const typewriterScore = clamp(
    Math.round(cycleScore * 70 + structuredSweepScore * 20 + resetDisciplineScore * 10),
    0,
    100,
  );
  const isTypewriterMovement =
    typewriterScore >= 68 && lineSweepCycles >= 3 && structuredSweepScore >= 0.45;
  const confidence = getConfidence(cheatingScore, total);

  let reason =
    `Events: ${total}, line-sweep cycles: ${lineSweepCycles}, max sweep streak: ${maxStreak}.`;
  if (transitions > rapidTransitions) {
    reason += ` Ignored ${transitions - rapidTransitions} long pauses (natural thinking).`;
  }
  if (dartingPenalty > 0) {
    reason += " Fast short alternations looked more like nervous darting than line-by-line reading.";
  }
  if (isTypewriterMovement) {
    reason += " Candidate appears to be reading line by line across the screen.";
  }

  return {
    isCheating,
    cheatingScore,
    isTypewriterMovement,
    typewriterScore,
    confidence,
    summary: isCheating
      ? "Pattern matches repeated line-by-line reading sweeps across the screen."
      : "Pattern looks closer to natural thinking pauses and unstructured conversational eye movement.",
    reason,
    recommendation: isCheating
      ? "Ask a follow-up that requires direct recall and maintain observation."
      : "Continue monitoring across additional windows for consistency.",
    pattern,
    eventCount: total,
  };
}

function createRoomState(roomId) {
  return {
    roomId,
    participants: new Map(),
    interviewStarted: false,
    activeSharePeerId: null,
    activeShareRole: null,
    activeShareSurface: null,
    waitingFor: "candidate",
    updatedAt: Date.now(),
  };
}

function serializeParticipant(participant) {
  return {
    peerId: participant.peerId,
    name: participant.name,
    role: participant.role,
    muted: participant.muted,
    cameraOff: participant.cameraOff,
    shareActive: participant.shareActive,
    displaySurface: participant.displaySurface,
    joinedAt: participant.joinedAt,
  };
}

function serializeUsers(room) {
  return Array.from(room.participants.values()).map(serializeParticipant);
}

function buildRoomState(room) {
  const participants = Array.from(room.participants.values());
  const candidates = participants.filter((participant) => participant.role === "candidate");
  const interviewers = participants.filter((participant) => participant.role === "interviewer");
  const activeShares = participants.filter((participant) => participant.shareActive);
  const candidateShare = activeShares.find(
    (participant) =>
      participant.role === "candidate" && participant.displaySurface === "monitor",
  );

  let waitingFor = "ready";
  if (candidates.length === 0) waitingFor = "candidate";
  else if (interviewers.length === 0) waitingFor = "interviewer";
  else if (activeShares.length > 1) waitingFor = "single_screen_share";
  else if (!candidateShare) waitingFor = "candidate_screen";

  const interviewStarted =
    candidates.length > 0 &&
    interviewers.length > 0 &&
    activeShares.length === 1 &&
    Boolean(candidateShare);

  room.interviewStarted = interviewStarted;
  room.activeSharePeerId = candidateShare?.peerId || null;
  room.activeShareRole = candidateShare?.role || null;
  room.activeShareSurface = candidateShare?.displaySurface || null;
  room.waitingFor = waitingFor;
  room.updatedAt = Date.now();

  return {
    roomId: room.roomId,
    interviewStarted,
    hasCandidate: candidates.length > 0,
    hasInterviewer: interviewers.length > 0,
    shareRequirementMet: Boolean(candidateShare),
    activeSharePeerId: room.activeSharePeerId,
    activeShareRole: room.activeShareRole,
    activeShareSurface: room.activeShareSurface,
    waitingFor,
    participantCount: participants.length,
  };
}

function validateShareRequest(room, participant, nextShareState) {
  if (!nextShareState?.active) {
    return {
      accepted: true,
      active: false,
      displaySurface: nextShareState?.displaySurface || null,
    };
  }

  if (participant.role !== "candidate") {
    return {
      accepted: false,
      active: false,
      displaySurface: null,
      message: "Only the candidate can share a screen in the interview room.",
    };
  }

  if (nextShareState.displaySurface !== "monitor") {
    return {
      accepted: false,
      active: false,
      displaySurface: nextShareState.displaySurface || null,
      message: "The interview can start only when the entire screen is shared.",
    };
  }

  const existingShare = Array.from(room.participants.values()).find(
    (currentParticipant) =>
      currentParticipant.peerId !== participant.peerId && currentParticipant.shareActive,
  );

  if (existingShare) {
    return {
      accepted: false,
      active: false,
      displaySurface: nextShareState.displaySurface,
      message: "Only one active screen share is allowed in an interview room.",
    };
  }

  return {
    accepted: true,
    active: true,
    displaySurface: nextShareState.displaySurface,
  };
}

const app = express();
assertProductionConfig();
ensureUsersFile();
const allowedOrigins = parseAllowedOrigins();
if (process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
}

app.use((req, res, next) => {
  applySecurityHeaders(res);
  applyCorsHeaders(req, res, allowedOrigins);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
});
app.use(express.json({ limit: "1mb" }));
const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

app.post("/analyze-eye-movement", (req, res) => {
  try {
    const { movementEvents, eyeMovement, phase, sessionContext } = req.body || {};

    const normalizedEvents =
      Array.isArray(movementEvents) && movementEvents.length > 0
        ? movementEvents
        : String(eyeMovement || "")
            .split("")
            .filter((value) => value === "L" || value === "R")
            .map((direction) => ({ direction, timestamp: null }));

    if (!phase) {
      res.status(400).json({ error: "Missing phase" });
      return;
    }

    const firstTimestamp = normalizedEvents[0]?.timestamp || null;
    const lastTimestamp = normalizedEvents[normalizedEvents.length - 1]?.timestamp || null;
    const analyzed = analyzeEyeEventsHeuristically(normalizedEvents, phase);

    res.json({
      phase,
      isCheating: analyzed.isCheating,
      cheatingScore: analyzed.cheatingScore,
      isTypewriterMovement: analyzed.isTypewriterMovement,
      typewriterScore: analyzed.typewriterScore,
      confidence: analyzed.confidence,
      summary: analyzed.summary,
      reason: analyzed.reason,
      recommendation: analyzed.recommendation,
      windowStart: firstTimestamp,
      windowEnd: lastTimestamp,
      eventCount: analyzed.eventCount,
      pattern: analyzed.pattern,
      sessionContext: sessionContext || null,
    });
  } catch (error) {
    console.error("Error analyzing eye movement:", error);
    const message = String(error?.message || "Unknown error");
    res.status(500).json({ error: "Failed to analyze eye movement", details: message });
  }
});

app.post("/analyze-session", (req, res) => {
  try {
    const { eyeMovements, phase, questionContext } = req.body || {};

    if (!Array.isArray(eyeMovements) || !phase) {
      res.status(400).json({ error: "Invalid request format" });
      return;
    }

    const flattened = eyeMovements
      .flatMap((value) => String(value || "").split(""))
      .filter((value) => value === "L" || value === "R")
      .map((direction) => ({ direction, timestamp: null }));

    if (flattened.length === 0) {
      res.json({
        overallAssessment: "neutral",
        readingProbability: 0,
        patterns: ["No valid directional events found in session payload"],
        confidence: "low",
        additionalNotes: "Unable to analyze session without L/R movement data.",
      });
      return;
    }

    const result = analyzeEyeEventsHeuristically(flattened, phase);
    const overallAssessment =
      result.cheatingScore >= 70
        ? "reading"
        : result.cheatingScore >= 45
          ? "distracted"
          : "focused";

    res.json({
      overallAssessment,
      readingProbability: result.cheatingScore,
      patterns: [
        `Pattern sample: ${result.pattern.slice(0, 50)}${result.pattern.length > 50 ? "..." : ""}`,
        result.reason,
      ],
      confidence: result.confidence,
      additionalNotes: questionContext || "Heuristic session-level analysis completed.",
    });
  } catch (error) {
    console.error("Error analyzing session:", error);
    res.status(500).json({ error: "Failed to analyze session", details: error.message });
  }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
  },
});

const port = process.env.PORT || 3000;
const rooms = new Map();
const spacetime = createSpacetimeClient();
const twilioIce = createTwilioIceService();
const aiReview = createAiReviewService();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, createRoomState(roomId));
  }
  return rooms.get(roomId);
}

function emitAiScoreUpdate(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const snapshot = getAiSnapshot(roomId);
  room.participants.forEach((participant) => {
    if (participant.role === "interviewer") {
      io.to(participant.socketId).emit("ai-score-update", snapshot);
    }
  });
}

function emitAiTranscriptUpdate(roomId) {
  const room = rooms.get(roomId);
  const state = aiInterviewState.get(roomId);
  if (!room || !state) return;

  const transcripts = state.transcriptHistory.slice(-AI_DISPLAY_TRANSCRIPT_HISTORY);
  room.participants.forEach((participant) => {
    if (participant.role === "interviewer") {
      io.to(participant.socketId).emit("ai-transcript-update", {
        transcripts,
        draft: state.liveDraft,
        mode: state.transcriptMode,
      });
    }
  });
}

function emitEyeAnalysisUpdate(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const snapshot = getOrCreateEyeState(roomId);
  room.participants.forEach((participant) => {
    if (participant.role === "interviewer") {
      io.to(participant.socketId).emit("eye-analysis-update", {
        ...snapshot.latest,
        history: snapshot.history,
      });
    }
  });
}

function scheduleAiAnalysis(roomId) {
  const state = getOrCreateAiState(roomId);
  state.status = "analyzing";
  state.detail = "Paragraph complete. Sending to Gemini for scoring.";
  emitAiScoreUpdate(roomId);

  console.log(`[ai-review] paragraph ready for room ${roomId}, calling Gemini now`);
  runAiAnalysis(roomId);
}

function runAiAnalysis(roomId) {
  const state = getOrCreateAiState(roomId);
  state.analysisPromise = state.analysisPromise
    .then(async () => {
      const transcriptWindow = state.transcriptSegments.slice(-AI_MAX_SEGMENTS).join(" ").trim();
      if (countWords(transcriptWindow) < AI_ANALYSIS_MIN_WORDS) {
        state.status = "listening";
        state.detail = "Waiting for a few more spoken words before scoring.";
        emitAiScoreUpdate(roomId);
        return;
      }

      const priorContext = state.transcriptHistory
        .slice(-(AI_MAX_HISTORY + AI_MAX_SEGMENTS), -AI_MAX_SEGMENTS)
        .map((entry) => entry.text)
        .join(" ")
        .trim();
      try {
        console.log(`[ai-review] scoring ${countWords(transcriptWindow)} words for room ${roomId}`);
        const result = await aiReview.scoreTranscript(transcriptWindow, priorContext);
        console.log(`[ai-review] Gemini returned aiLikelihood=${result.aiLikelihood} confidence=${result.confidence}`);
        state.scoreHistory.push({
          aiLikelihood: result.aiLikelihood,
          confidence: result.confidence,
          createdAt: Date.now(),
        });
        if (state.scoreHistory.length > AI_MAX_HISTORY) {
          state.scoreHistory.shift();
        }

        // Clear segments after scoring so next paragraph gets fresh analysis
        state.transcriptSegments = [];

        const average =
          state.scoreHistory.reduce((sum, item) => sum + item.aiLikelihood, 0) /
          state.scoreHistory.length;
        state.rollingAiLikelihood = Math.round(average);
        state.confidence = result.confidence;
        state.updatedAt = Date.now();
        state.status = "ready";
        state.detail = "Live AI likelihood updated from recent response.";
        emitAiScoreUpdate(roomId);
      } catch (error) {
        console.error("[ai-review] scoring failed", error.message);
        state.status = "error";
        state.detail = `Gemini scoring failed: ${error.message}`;
        emitAiScoreUpdate(roomId);
      }
    })
    .catch((error) => {
      console.error("[ai-review] analysis queue failed", error.message);
    });
}

function queueTranscriptForAnalysis(roomId, transcript, options = {}) {
  const normalizedTranscript = compactWhitespace(transcript);
  if (!normalizedTranscript) {
    return;
  }

  const state = getOrCreateAiState(roomId);
  state.liveDraft = "";
  const skipHistoryPush = Boolean(options.skipHistoryPush);
  const addedToHistory = skipHistoryPush
    ? true
    : pushTranscriptHistory(state, normalizedTranscript);
  if (!addedToHistory) {
    state.status = "listening";
    state.detail = "Repeated transcript ignored. Waiting for the next spoken phrase.";
    emitAiScoreUpdate(roomId);
    return;
  }
  if (!skipHistoryPush) {
    emitAiTranscriptUpdate(roomId);
  }

  if (countWords(normalizedTranscript) < AI_TRANSCRIPT_MIN_WORDS) {
    state.status = "listening";
    state.detail = "Short speech captured. Waiting for a longer answer.";
    emitAiScoreUpdate(roomId);
    return;
  }

  state.transcriptSegments.push(normalizedTranscript);
  state.status = "listening";
  state.detail = "Captured candidate speech. Updating live analysis.";
  if (state.transcriptSegments.length > AI_MAX_SEGMENTS) {
    state.transcriptSegments.shift();
  }

  emitAiScoreUpdate(roomId);
  scheduleAiAnalysis(roomId);
}

function flushPendingParagraph(roomId) {
  const state = getOrCreateAiState(roomId);
  const paragraph = compactWhitespace(state.pendingParagraph);
  state.pendingParagraph = "";
  if (!paragraph) {
    return;
  }

  console.log(`[ai-review] flushing paragraph (${countWords(paragraph)} words) for room ${roomId}`);
  queueTranscriptForAnalysis(roomId, paragraph, { skipHistoryPush: true });
}

function appendTranscriptForScoring(roomId, transcript) {
  const normalizedTranscript = compactWhitespace(transcript);
  if (!normalizedTranscript) return;

  const state = getOrCreateAiState(roomId);
  state.pendingParagraph = compactWhitespace(
    `${state.pendingParagraph ? `${state.pendingParagraph} ` : ""}${normalizedTranscript}`,
  );

  // Only flush when the paragraph has enough words — no timers.
  const paragraphWordCount = countWords(state.pendingParagraph);
  state.status = "listening";
  state.detail = `Buffer: ${paragraphWordCount}/${AI_PARAGRAPH_MIN_WORDS} words`;
  emitAiScoreUpdate(roomId);

  if (paragraphWordCount >= AI_PARAGRAPH_MIN_WORDS) {
    console.log(`[ai-review] buffer hit ${paragraphWordCount} words, flushing for room ${roomId}`);
    flushPendingParagraph(roomId);
  }
}

function updateLiveTranscript(roomId, text, isFinal) {
  const state = getOrCreateAiState(roomId);
  state.transcriptMode = "browser";

  if (isFinal) {
    pushTranscriptHistory(state, text);
    appendTranscriptForScoring(roomId, text);
    state.status = "listening";
    state.detail = "Captured finalized transcript from the candidate browser.";
    emitAiTranscriptUpdate(roomId);
    emitAiScoreUpdate(roomId);
    return;
  }

  state.liveDraft = compactWhitespace(text);
  state.transcriptMode = "streaming";
  state.status = "listening";
  state.detail = state.liveDraft
    ? "Streaming live transcript from the candidate browser."
    : "Listening for candidate speech.";
  emitAiScoreUpdate(roomId);
  emitAiTranscriptUpdate(roomId);
}

function emitRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const state = buildRoomState(room);
  const users = serializeUsers(room);
  io.to(roomId).emit("room-state", state);
  spacetime.syncRoomSnapshot(roomId, state, users);
}

function removeParticipant(roomId, peerId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const removedParticipant = room.participants.get(peerId);
  room.participants.delete(peerId);
  spacetime.removeParticipant(roomId, peerId);
  if (room.participants.size === 0) {
    clearAiState(roomId);
    clearEyeState(roomId);
    rooms.delete(roomId);
    return;
  }
  if (removedParticipant?.role === "candidate") {
    clearAiState(roomId);
    clearEyeState(roomId);
    emitAiScoreUpdate(roomId);
    emitEyeAnalysisUpdate(roomId);
  }
  emitRoomState(roomId);
}

function canRelaySignal(roomId, fromPeerId, targetPeerId) {
  const room = rooms.get(roomId);
  if (!room) return false;
  if (!room.participants.has(fromPeerId) || !room.participants.has(targetPeerId)) {
    return false;
  }
  return buildRoomState(room).interviewStarted;
}

function getAuthToken(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

function requireAuth(req, res, next) {
  const token = getAuthToken(req);
  if (!token) {
    res.status(401).json({ ok: false, message: "Missing auth token." });
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ ok: false, message: "Invalid or expired token." });
    return;
  }

  req.user = payload;
  next();
}

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    origins: IS_PRODUCTION ? undefined : allowedOrigins,
    db: spacetime.getStatus(),
    ai: {
      transcription: aiReview.isTranscriptionEnabled(),
      scoring: aiReview.isScoringEnabled(),
    },
  });
});

app.get("/", (_, res) => {
  res.json({
    service: "hackbyte-live-signaling",
    ok: true,
    health: "/health",
  });
});

app.post("/api/auth/register", authLimiter, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const role = normalizeRole(req.body?.role);

  if (!email || !password || !role) {
    res.status(400).json({ ok: false, message: "Email, password, and role are required." });
    return;
  }

  if (!isValidEmail(email)) {
    res.status(400).json({ ok: false, message: "Enter a valid email address." });
    return;
  }

  if (!isStrongEnoughPassword(password)) {
    res.status(400).json({ ok: false, message: "Password must be at least 8 characters long." });
    return;
  }

  const users = readUsers();
  if (users.some((user) => user.email === email)) {
    res.status(409).json({ ok: false, message: "An account with this email already exists." });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: crypto.randomUUID(),
    email,
    passwordHash,
    role,
    createdAt: Date.now(),
  };

  users.push(user);
  writeUsers(users);
  spacetime.appendUser(user);
  spacetime.appendAuthEvent("register", { userId: user.id, email, role });

  const token = createToken(user);
  res.status(201).json({
    ok: true,
    token,
    user: sanitizeUser(user),
  });
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");

  if (!email || !password) {
    res.status(400).json({ ok: false, message: "Email and password are required." });
    return;
  }

  const users = readUsers();
  const user = users.find((currentUser) => currentUser.email === email);

  if (!user) {
    res.status(401).json({ ok: false, message: "Invalid email or password." });
    return;
  }

  const validPassword = await bcrypt.compare(password, user.passwordHash);
  if (!validPassword) {
    res.status(401).json({ ok: false, message: "Invalid email or password." });
    return;
  }

  spacetime.appendAuthEvent("login", { userId: user.id, email: user.email, role: user.role });

  const token = createToken(user);
  res.json({
    ok: true,
    token,
    user: sanitizeUser(user),
  });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  const users = readUsers();
  const user = users.find((currentUser) => currentUser.id === req.user.sub);

  if (!user) {
    res.status(404).json({ ok: false, message: "User not found." });
    return;
  }

  res.json({
    ok: true,
    user: sanitizeUser(user),
  });
});

app.get("/api/rtc/ice-servers", requireAuth, async (_, res) => {
  try {
    const iceServers = await twilioIce.getIceServers();
    res.json({
      ok: true,
      iceServers,
      provider: twilioIce.isEnabled() ? "twilio" : "fallback",
      ttl: twilioIce.isEnabled() ? TWILIO_NTS_TTL : null,
    });
  } catch (error) {
    console.error("[twilio] failed to create network traversal token", error.message);
    res.json({
      ok: true,
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      provider: "fallback",
      ttl: null,
      warning: "Twilio ICE fetch failed. Falling back to STUN only.",
    });
  }
});

app.post("/api/analyze-resume", requireAuth, resumeUpload.single("resume"), async (req, res) => {
  if (req.user.role !== "interviewer") {
    res.status(403).json({
      success: false,
      message: "Only interviewers can analyze resumes.",
    });
    return;
  }

  if (!req.file) {
    res.status(400).json({
      success: false,
      message: "No resume file uploaded.",
    });
    return;
  }

  if (req.file.mimetype !== "application/pdf") {
    res.status(400).json({
      success: false,
      message: "Only PDF files are supported.",
    });
    return;
  }

  try {
    const result = await analyzeResumePipeline(req.file.buffer);
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("[resume-analysis] failed", error.message);
    res.status(error.statusCode || 500).json({
      success: false,
      message: "Failed to analyze resume pipeline.",
      error: error.message,
    });
  }
});

// ============================================
// PROGRESSIVE RESUME / VERIFIER API ENDPOINTS
// ============================================

app.post("/api/analyze-resume/extract", requireAuth, resumeUpload.single("resume"), async (req, res) => {
  if (req.user.role !== "interviewer") {
    return res.status(403).json({ success: false, message: "Only interviewers can extract resumes." });
  }
  if (!req.file || req.file.mimetype !== "application/pdf") {
    return res.status(400).json({ success: false, message: "A valid PDF file is required." });
  }

  try {
    const { extractedData, rawText } = await extractResumeData(req.file.buffer, []);
    extractedData._pdfHyperlinks = Array.from(new Set((String(rawText || "").match(/https?:\/\/[^\s)>\]]+/gi) || []).map(l => l.replace(/[),.;]+$/, ""))));
    res.json({ success: true, data: { extractedData, rawText } });
  } catch (error) {
    console.error("[extractResume] failed", error);
    res.status(error.statusCode || 500).json({ success: false, message: "Extraction failed.", error: error.message });
  }
});

app.post("/api/verify/ats-score", requireAuth, async (req, res) => {
  try {
    const { resumeText } = req.body;
    if (!resumeText) return res.status(400).json({ error: "resumeText is required" });
    const result = await analyzeAtsScore(resumeText);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Internal server error analyzing ATS" });
  }
});

app.post("/api/verify/github", requireAuth, async (req, res) => {
  const { username, profileUrl } = req.body ?? {};
  if (!username && !profileUrl) return res.status(400).json({ success: false, message: "username or profileUrl required" });
  
  const normalized = extractGithubUsername(username || profileUrl);
  if (!normalized) return res.status(400).json({ success: false, message: "Invalid GitHub username/url" });

  try {
    const result = await verifyGithubProfile(normalized);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

app.post("/api/verify/projects", requireAuth, async (req, res) => {
  try {
    const result = await verifyGithubProjects(req.body ?? {});
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

app.post("/api/verify/github-commits", requireAuth, async (req, res) => {
  try {
    const { owner, repoName } = req.body;
    if (!owner || !repoName) return res.status(400).json({ error: "owner and repoName required" });
    const result = await analyzeCommitsAndContributors(owner, repoName);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Internal server error analyzing commits" });
  }
});

app.post("/api/verify/github-skill-decay", requireAuth, async (req, res) => {
  try {
    const { username, claimedSkills } = req.body;
    if (!username || !claimedSkills) return res.status(400).json({ error: "username and claimedSkills required" });
    const result = await analyzeSkillDecay(username, claimedSkills);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Internal server error analyzing skill decay" });
  }
});

app.post("/api/verify/coding-profiles", requireAuth, async (req, res) => {
  try {
    const { codingProfiles } = req.body ?? {};
    if (!codingProfiles || typeof codingProfiles !== "object") {
      return res.status(400).json({ success: false, message: "Invalid codingProfiles object" });
    }
    const result = await verifyCodingProfiles(codingProfiles);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/verify/leetcode", requireAuth, async (req, res) => {
  try {
    if (!req.body?.username) return res.status(400).json({ success: false, message: "username required" });
    const result = await verifyLeetCode(req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/verify/codeforces", requireAuth, async (req, res) => {
  try {
    if (!req.body?.username) return res.status(400).json({ success: false, message: "username required" });
    const result = await verifyCodeforces(req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/verify/codechef", requireAuth, async (req, res) => {
  try {
    if (!req.body?.username) return res.status(400).json({ success: false, message: "username required" });
    const result = await verifyCodechef(req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/generate-review", requireAuth, async (req, res) => {
  try {
    if (!req.body?.verificationData) return res.status(400).json({ error: "verificationData required" });
    const result = await generateFinalReview(req.body.verificationData);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Internal server error computing final review" });
  }
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    next(new Error("Missing auth token."));
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    next(new Error("Invalid or expired token."));
    return;
  }

  socket.data.authUser = payload;
  next();
});

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, peerId, shareState }, callback) => {
    const authUser = socket.data.authUser;
    const normalizedRole = normalizeRole(authUser?.role);

    if (!roomId || !peerId || !normalizedRole || !isValidRoomId(roomId)) {
      callback?.({
        ok: false,
        message: "A valid room id, peer id, and role are required.",
      });
      return;
    }

    const room = getRoom(roomId);
    const participant = {
      socketId: socket.id,
      peerId,
      roomId,
      name: authUser.email,
      role: normalizedRole,
      muted: false,
      cameraOff: normalizedRole === "candidate",
      shareActive: false,
      displaySurface: null,
      joinedAt: Date.now(),
    };
    const validatedShare = validateShareRequest(room, participant, shareState);

    participant.shareActive = validatedShare.active;
    participant.displaySurface = validatedShare.displaySurface;
    participant.cameraOff = normalizedRole === "candidate" ? !validatedShare.active : false;

    room.participants.set(peerId, participant);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.peerId = peerId;
    socket.data.role = normalizedRole;

    socket.emit("room-users", { users: serializeUsers(room) });
    socket.emit("room-state", buildRoomState(room));
    if (normalizedRole === "interviewer") {
      socket.emit("ai-score-update", getAiSnapshot(roomId));
      socket.emit("ai-transcript-update", {
        transcripts: getOrCreateAiState(roomId).transcriptHistory.slice(-AI_DISPLAY_TRANSCRIPT_HISTORY),
        draft: getOrCreateAiState(roomId).liveDraft,
        mode: getOrCreateAiState(roomId).transcriptMode,
      });
      socket.emit("eye-analysis-update", {
        ...getOrCreateEyeState(roomId).latest,
        history: getOrCreateEyeState(roomId).history,
      });
    }
    socket.to(roomId).emit("peer-joined", serializeParticipant(participant));

    if (!validatedShare.accepted && validatedShare.message) {
      socket.emit("room-error", {
        code: "SCREEN_SHARE_REJECTED",
        message: validatedShare.message,
      });
    }

    spacetime.appendRoomEvent(roomId, "join_room", {
      peerId,
      role: normalizedRole,
      shareActive: participant.shareActive,
    });
    emitRoomState(roomId);

    callback?.({
      ok: true,
      peerId,
      role: normalizedRole,
      roomState: buildRoomState(room),
    });
  });

  socket.on("offer", ({ roomId, targetPeerId, from, signal }) => {
    if (!canRelaySignal(roomId, from, targetPeerId)) {
      socket.emit("room-error", {
        code: "INTERVIEW_NOT_READY",
        message: "The interview has not started yet. Wait for a candidate to share their entire screen.",
      });
      return;
    }
    io.to(targetPeerId).emit("offer", { from, signal });
  });

  socket.on("answer", ({ roomId, targetPeerId, from, signal }) => {
    if (!canRelaySignal(roomId, from, targetPeerId)) {
      socket.emit("room-error", {
        code: "INTERVIEW_NOT_READY",
        message: "The interview has not started yet. Wait for the screen-share requirement to be met.",
      });
      return;
    }
    io.to(targetPeerId).emit("answer", { from, signal });
  });

  socket.on("ice-candidate", ({ roomId, targetPeerId, from, candidate }) => {
    if (!canRelaySignal(roomId, from, targetPeerId)) {
      socket.emit("room-error", {
        code: "INTERVIEW_NOT_READY",
        message: "The interview has not started yet. ICE candidates are blocked until the room is ready.",
      });
      return;
    }
    io.to(targetPeerId).emit("ice-candidate", { from, candidate });
  });

  socket.on("share-state", ({ roomId, peerId, active, displaySurface }, callback) => {
    const room = rooms.get(roomId);
    const participant = room?.participants.get(peerId);

    if (!room || !participant) {
      callback?.({ ok: false, message: "Participant not found in room." });
      return;
    }

    const validatedShare = validateShareRequest(room, participant, { active, displaySurface });
    room.participants.set(peerId, {
      ...participant,
      shareActive: validatedShare.active,
      displaySurface: validatedShare.displaySurface,
      cameraOff: participant.role === "candidate" ? !validatedShare.active : participant.cameraOff,
    });

    io.to(roomId).emit("share-state-changed", {
      peerId,
      role: participant.role,
      shareActive: validatedShare.active,
      displaySurface: validatedShare.displaySurface,
    });

    if (!validatedShare.accepted && validatedShare.message) {
      socket.emit("room-error", {
        code: "SCREEN_SHARE_REJECTED",
        message: validatedShare.message,
      });
    }

    spacetime.appendRoomEvent(roomId, "share_state", {
      peerId,
      shareActive: validatedShare.active,
      displaySurface: validatedShare.displaySurface,
    });
    emitRoomState(roomId);

    callback?.({
      ok: validatedShare.accepted,
      shareActive: validatedShare.active,
      displaySurface: validatedShare.displaySurface,
      message: validatedShare.message || null,
    });
  });

  socket.on("media-state", ({ roomId, peerId, muted, cameraOff }) => {
    const room = rooms.get(roomId);
    if (!room?.participants.has(peerId)) return;

    const participant = room.participants.get(peerId);
    room.participants.set(peerId, {
      ...participant,
      muted,
      cameraOff: participant.role === "candidate" ? !participant.shareActive : cameraOff,
    });

    socket.to(roomId).emit("media-state-changed", {
      peerId,
      muted,
      cameraOff: room.participants.get(peerId).cameraOff,
    });

    emitRoomState(roomId);
  });

  socket.on(
    "eye-movement-batch",
    ({ roomId, peerId, movementEvents, phase }, callback) => {
      const room = rooms.get(roomId);
      const participant = room?.participants.get(peerId);

      if (!room || !participant) {
        callback?.({ ok: false, message: "Participant not found in room." });
        return;
      }

      if (participant.socketId !== socket.id || participant.role !== "candidate") {
        callback?.({ ok: false, message: "Only the candidate can send eye movement data." });
        return;
      }

      const normalizedEvents = Array.isArray(movementEvents)
        ? movementEvents.filter(
            (event) =>
              event &&
              (event.direction === "L" || event.direction === "R"),
          )
        : [];

      const analysis = analyzeEyeEventsHeuristically(
        normalizedEvents,
        phase || "ANSWER",
      );
      const eyeState = getOrCreateEyeState(roomId);
      const snapshot = {
        ...analysis,
        lastUpdatedAt: Date.now(),
      };

      eyeState.latest = snapshot;
      eyeState.history.push({
        cheatingScore: snapshot.cheatingScore,
        isCheating: snapshot.isCheating,
        timestamp: snapshot.lastUpdatedAt,
      });
      if (eyeState.history.length > 8) {
        eyeState.history.shift();
      }

      emitEyeAnalysisUpdate(roomId);
      callback?.({ ok: true });
    },
  );

  socket.on(
    "candidate-live-transcript",
    ({ roomId, peerId, text, isFinal }, callback) => {
      const room = rooms.get(roomId);
      const participant = room?.participants.get(peerId);

      if (!room || !participant) {
        callback?.({ ok: false, message: "Participant not found in room." });
        return;
      }

      if (participant.socketId !== socket.id || participant.role !== "candidate") {
        callback?.({ ok: false, message: "Only the candidate can stream transcript updates." });
        return;
      }

      if (!buildRoomState(room).interviewStarted) {
        callback?.({ ok: false, message: "Interview transcription is available only after the interview starts." });
        return;
      }

      updateLiveTranscript(roomId, text, Boolean(isFinal));
      callback?.({ ok: true });
    },
  );

  socket.on(
    "candidate-audio-chunk",
    async ({ roomId, peerId, mimeType, audioBase64 }, callback) => {
      const room = rooms.get(roomId);
      const participant = room?.participants.get(peerId);

      if (!room || !participant) {
        callback?.({ ok: false, message: "Participant not found in room." });
        return;
      }

      if (participant.socketId !== socket.id || participant.role !== "candidate") {
        callback?.({ ok: false, message: "Only the candidate can upload interview audio." });
        return;
      }

      if (!buildRoomState(room).interviewStarted) {
        callback?.({ ok: false, message: "Interview audio can be processed only after the interview starts." });
        return;
      }

      if (!audioBase64 || !aiReview.isTranscriptionEnabled()) {
        callback?.({ ok: true, skipped: true });
        return;
      }

      try {
        const aiState = getOrCreateAiState(roomId);
        aiState.chunkCount += 1;
        aiState.transcriptMode = "deepgram";
        aiState.status = "listening";
        aiState.detail = "Audio chunk received. Transcribing candidate speech.";
        emitAiScoreUpdate(roomId);

        const audioBuffer = Buffer.from(audioBase64, "base64");
        if (!audioBuffer.length) {
          callback?.({ ok: true, skipped: true });
          return;
        }

        const transcript = await aiReview.transcribeChunk(audioBuffer, mimeType);
        if (transcript) {
          pushTranscriptHistory(aiState, transcript);
          appendTranscriptForScoring(roomId, transcript);
          emitAiTranscriptUpdate(roomId);
        } else {
          aiState.status = "listening";
          aiState.detail = "Audio received, but no clear speech was transcribed.";
          emitAiScoreUpdate(roomId);
        }

        callback?.({ ok: true });
      } catch (error) {
        console.error("[ai-review] transcription failed", error.message);
        const aiState = getOrCreateAiState(roomId);
        aiState.status = "error";
        aiState.detail = "Deepgram transcription failed for the latest audio chunk.";
        emitAiScoreUpdate(roomId);
        callback?.({ ok: false, message: "Unable to process interview audio right now." });
      }
    },
  );

  socket.on("leave-room", ({ roomId, peerId }) => {
    removeParticipant(roomId, peerId);
    socket.leave(roomId);
    socket.to(roomId).emit("peer-left", { peerId });
    spacetime.appendRoomEvent(roomId, "leave_room", { peerId });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const peerId = socket.data.peerId;
    if (!roomId || !peerId) return;
    removeParticipant(roomId, peerId);
    socket.to(roomId).emit("peer-left", { peerId });
    spacetime.appendRoomEvent(roomId, "disconnect", { peerId });
  });
});

const activeServer = server.listen(port, () => {
  console.log(`Signaling server listening on port ${port}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down gracefully.`);
  activeServer.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
