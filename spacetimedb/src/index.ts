import { schema, table, t } from "spacetimedb/server";

const RoomState = table(
  {
    name: "room_state",
    public: true,
  },
  {
    room_id: t.string(),
    interview_started: t.bool(),
    has_candidate: t.bool(),
    has_interviewer: t.bool(),
    share_requirement_met: t.bool(),
    active_share_peer_id: t.option(t.string()),
    active_share_role: t.option(t.string()),
    active_share_surface: t.option(t.string()),
    waiting_for: t.string(),
    updated_at: t.i64(),
  },
);

const ParticipantState = table(
  {
    name: "participant_state",
    public: true,
  },
  {
    peer_id: t.string(),
    room_id: t.string(),
    name: t.string(),
    role: t.string(),
    muted: t.bool(),
    camera_off: t.bool(),
    share_active: t.bool(),
    display_surface: t.option(t.string()),
    joined_at: t.i64(),
    updated_at: t.i64(),
  },
);

const RoomEvent = table(
  {
    name: "room_event",
    public: true,
  },
  {
    room_id: t.string(),
    event_type: t.string(),
    payload: t.string(),
    created_at: t.i64(),
  },
);

const UserAccount = table(
  {
    name: "user_account",
    public: true,
  },
  {
    user_id: t.string(),
    email: t.string(),
    role: t.string(),
    password_hash: t.string(),
    created_at: t.i64(),
    updated_at: t.i64(),
  },
);

const AuthEvent = table(
  {
    name: "auth_event",
    public: true,
  },
  {
    event_type: t.string(),
    payload: t.string(),
    created_at: t.i64(),
  },
);

const spacetimedb = schema(RoomState, ParticipantState, RoomEvent, UserAccount, AuthEvent);

function findRoomById(ctx: any, roomId: string) {
  for (const room of ctx.db.roomState.iter()) {
    if (room.room_id === roomId) {
      return room;
    }
  }

  return null;
}

function findParticipantByPeerId(ctx: any, peerId: string) {
  for (const participant of ctx.db.participantState.iter()) {
    if (participant.peer_id === peerId) {
      return participant;
    }
  }

  return null;
}

function findUserById(ctx: any, userId: string) {
  for (const user of ctx.db.userAccount.iter()) {
    if (user.user_id === userId) {
      return user;
    }
  }

  return null;
}

spacetimedb.reducer(
  "sync_room",
  {
    room_id: t.string(),
    interview_started: t.bool(),
    has_candidate: t.bool(),
    has_interviewer: t.bool(),
    share_requirement_met: t.bool(),
    active_share_peer_id: t.option(t.string()),
    active_share_role: t.option(t.string()),
    active_share_surface: t.option(t.string()),
    waiting_for: t.string(),
    updated_at: t.i64(),
  },
  (ctx, payload) => {
    const existing = findRoomById(ctx, payload.room_id);

    if (existing) {
      ctx.db.roomState.delete(existing);
    }

    ctx.db.roomState.insert(payload);
  },
);

spacetimedb.reducer(
  "upsert_participant",
  {
    room_id: t.string(),
    peer_id: t.string(),
    name: t.string(),
    role: t.string(),
    muted: t.bool(),
    camera_off: t.bool(),
    share_active: t.bool(),
    display_surface: t.option(t.string()),
    joined_at: t.i64(),
    updated_at: t.i64(),
  },
  (ctx, payload) => {
    const existing = findParticipantByPeerId(ctx, payload.peer_id);

    if (existing) {
      ctx.db.participantState.delete(existing);
      ctx.db.participantState.insert({
        ...payload,
        joined_at: existing.joined_at,
      });
      return;
    }

    ctx.db.participantState.insert(payload);
  },
);

spacetimedb.reducer(
  "remove_participant",
  {
    room_id: t.string(),
    peer_id: t.string(),
  },
  (ctx, payload) => {
    const existing = findParticipantByPeerId(ctx, payload.peer_id);

    if (existing) {
      ctx.db.participantState.delete(existing);
    }
  },
);

spacetimedb.reducer(
  "append_room_event",
  {
    room_id: t.string(),
    event_type: t.string(),
    payload: t.string(),
    created_at: t.i64(),
  },
  (ctx, payload) => {
    ctx.db.roomEvent.insert(payload);
  },
);

spacetimedb.reducer(
  "upsert_user",
  {
    user_id: t.string(),
    email: t.string(),
    role: t.string(),
    password_hash: t.string(),
    created_at: t.i64(),
    updated_at: t.i64(),
  },
  (ctx, payload) => {
    const existing = findUserById(ctx, payload.user_id);

    if (existing) {
      ctx.db.userAccount.delete(existing);
      ctx.db.userAccount.insert({
        ...payload,
        created_at: existing.created_at,
      });
      return;
    }

    ctx.db.userAccount.insert(payload);
  },
);

spacetimedb.reducer(
  "append_auth_event",
  {
    event_type: t.string(),
    payload: t.string(),
    created_at: t.i64(),
  },
  (ctx, payload) => {
    ctx.db.authEvent.insert(payload);
  },
);

spacetimedb.reducer(
  "cleanup_room",
  {
    room_id: t.string(),
  },
  (ctx, payload) => {
    const room = findRoomById(ctx, payload.room_id);

    if (room) {
      ctx.db.roomState.delete(room);
    }
  },
);

export default spacetimedb;
