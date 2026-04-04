require("dotenv").config();

const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
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
const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{3,120}$/;
const authRateLimiter = new Map();

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

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, createRoomState(roomId));
  }
  return rooms.get(roomId);
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
  room.participants.delete(peerId);
  spacetime.removeParticipant(roomId, peerId);
  if (room.participants.size === 0) {
    rooms.delete(roomId);
    return;
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
