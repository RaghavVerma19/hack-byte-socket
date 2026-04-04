require("dotenv").config();

const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const twilio = require("twilio");
const { execFile } = require("child_process");
const { Server } = require("socket.io");

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
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash-lite";
const AI_TRANSCRIPT_MIN_WORDS = Number(process.env.AI_TRANSCRIPT_MIN_WORDS || 1);
const AI_ANALYSIS_MIN_WORDS = Number(process.env.AI_ANALYSIS_MIN_WORDS || 6);
const AI_MAX_SEGMENTS = Number(process.env.AI_MAX_SEGMENTS || 6);
const AI_MAX_HISTORY = Number(process.env.AI_MAX_HISTORY || 8);
const AI_ANALYSIS_DEBOUNCE_MS = Number(process.env.AI_ANALYSIS_DEBOUNCE_MS || 2000);
const authRateLimiter = new Map();
const aiInterviewState = new Map();

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

function buildEmptyAiSnapshot() {
  return {
    aiLikelihood: null,
    confidence: "idle",
    samplesAnalyzed: 0,
    chunkCount: 0,
    transcriptCount: 0,
    updatedAt: null,
    status: "idle",
    detail: "Waiting for candidate audio.",
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
      status: aiReview?.isTranscriptionEnabled?.() ? "listening" : "transcription_disabled",
      detail: aiReview?.isTranscriptionEnabled?.()
        ? "Listening for candidate speech."
        : "Deepgram is not configured on the backend.",
      transcriptMode: "waiting",
      liveDraft: "",
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
  aiInterviewState.delete(roomId);
}

function getAiSnapshot(roomId) {
  const state = aiInterviewState.get(roomId);
  if (!state) {
    const snapshot = buildEmptyAiSnapshot();
    if (!aiReview.isTranscriptionEnabled()) {
      snapshot.status = "transcription_disabled";
      snapshot.detail = "Deepgram is not configured on the backend.";
    } else if (!aiReview.isScoringEnabled()) {
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
        throw new Error(`Gemini request failed with ${response.status}`);
      }

      const payload = await response.json();
      const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
      const parsed = JSON.parse(text);

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

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
  },
});

const port = process.env.PORT || 4000;
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

  const transcripts = state.transcriptHistory.slice(-4);
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

function scheduleAiAnalysis(roomId) {
  const state = getOrCreateAiState(roomId);
  state.status = "analyzing";
  state.detail = "Analyzing recent candidate response.";
  emitAiScoreUpdate(roomId);
  if (state.analysisTimer) {
    clearTimeout(state.analysisTimer);
  }

  state.analysisTimer = setTimeout(() => {
    state.analysisTimer = null;
    runAiAnalysis(roomId);
  }, AI_ANALYSIS_DEBOUNCE_MS);
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
        const result = await aiReview.scoreTranscript(transcriptWindow, priorContext);
        state.scoreHistory.push({
          aiLikelihood: result.aiLikelihood,
          confidence: result.confidence,
          createdAt: Date.now(),
        });
        if (state.scoreHistory.length > AI_MAX_HISTORY) {
          state.scoreHistory.shift();
        }

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
        state.detail = "Gemini scoring is temporarily unavailable.";
        emitAiScoreUpdate(roomId);
      }
    })
    .catch((error) => {
      console.error("[ai-review] analysis queue failed", error.message);
    });
}

function queueTranscriptForAnalysis(roomId, transcript) {
  const normalizedTranscript = compactWhitespace(transcript);
  if (!normalizedTranscript) {
    return;
  }

  const state = getOrCreateAiState(roomId);
  state.liveDraft = "";
  state.transcriptHistory.push({
    text: normalizedTranscript,
    createdAt: Date.now(),
  });
  if (state.transcriptHistory.length > AI_MAX_HISTORY) {
    state.transcriptHistory.shift();
  }
  emitAiTranscriptUpdate(roomId);

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

function updateLiveTranscript(roomId, text, isFinal) {
  const state = getOrCreateAiState(roomId);
  state.transcriptMode = "browser";

  if (isFinal) {
    queueTranscriptForAnalysis(roomId, text);
    emitAiTranscriptUpdate(roomId);
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
    rooms.delete(roomId);
    return;
  }
  if (removedParticipant?.role === "candidate") {
    clearAiState(roomId);
    emitAiScoreUpdate(roomId);
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
        transcripts: getOrCreateAiState(roomId).transcriptHistory.slice(-4),
        draft: getOrCreateAiState(roomId).liveDraft,
        mode: getOrCreateAiState(roomId).transcriptMode,
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
          queueTranscriptForAnalysis(roomId, transcript);
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
