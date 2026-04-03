const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

function parseAllowedOrigins() {
  const rawOrigins = process.env.CLIENT_URLS || process.env.CLIENT_URL || "*";

  if (rawOrigins === "*") {
    return "*";
  }

  return rawOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const app = express();
const server = http.createServer(app);
const allowedOrigins = parseAllowedOrigins();
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"]
  }
});

const port = process.env.PORT || 4000;
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
  }

  return rooms.get(roomId);
}

function serializeUsers(room) {
  return Array.from(room.values()).map((participant) => ({
    peerId: participant.peerId,
    name: participant.name,
    muted: participant.muted,
    cameraOff: participant.cameraOff
  }));
}

function removeParticipant(roomId, peerId) {
  const room = rooms.get(roomId);

  if (!room) {
    return;
  }

  room.delete(peerId);

  if (room.size === 0) {
    rooms.delete(roomId);
  }
}

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    origins: allowedOrigins
  });
});

app.get("/", (_, res) => {
  res.json({
    service: "hackbyte-live-signaling",
    ok: true,
    health: "/health"
  });
});

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, peerId, name }) => {
    const room = getRoom(roomId);

    room.set(peerId, {
      socketId: socket.id,
      peerId,
      roomId,
      name: name || "Guest",
      muted: false,
      cameraOff: false
    });

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.peerId = peerId;

    socket.emit("room-users", {
      users: serializeUsers(room)
    });

    socket.to(roomId).emit("peer-joined", {
      peerId,
      name: name || "Guest",
      muted: false,
      cameraOff: false
    });
  });

  socket.on("offer", ({ targetPeerId, from, signal }) => {
    io.to(targetPeerId).emit("offer", {
      from,
      signal
    });
  });

  socket.on("answer", ({ targetPeerId, from, signal }) => {
    io.to(targetPeerId).emit("answer", {
      from,
      signal
    });
  });

  socket.on("ice-candidate", ({ targetPeerId, from, candidate }) => {
    io.to(targetPeerId).emit("ice-candidate", {
      from,
      candidate
    });
  });

  socket.on("media-state", ({ roomId, peerId, muted, cameraOff }) => {
    const room = rooms.get(roomId);

    if (!room?.has(peerId)) {
      return;
    }

    room.set(peerId, {
      ...room.get(peerId),
      muted,
      cameraOff
    });

    socket.to(roomId).emit("media-state-changed", {
      peerId,
      muted,
      cameraOff
    });
  });

  socket.on("leave-room", ({ roomId, peerId }) => {
    removeParticipant(roomId, peerId);
    socket.leave(roomId);
    socket.to(roomId).emit("peer-left", { peerId });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const peerId = socket.data.peerId;

    if (!roomId || !peerId) {
      return;
    }

    removeParticipant(roomId, peerId);
    socket.to(roomId).emit("peer-left", { peerId });
  });
});

server.listen(port, () => {
  console.log(`Signaling server listening on port ${port}`);
});
