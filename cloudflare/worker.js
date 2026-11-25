const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "https://ilyushenka2379-sketch.github.io",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS
  });
}

function hex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomToken() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

async function tokenHash(token) {
  return hex(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  ));
}

async function hashPassword(password, salt) {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  return hex(await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt: encoder.encode(salt),
    iterations: 100000,
    hash: "SHA-256"
  }, key, 256));
}

async function createSession(db, id) {
  const token = randomToken();

  await db.prepare(
    "INSERT INTO sessions (token,user_id,expires) VALUES (?,?,?)"
  ).bind(
    await tokenHash(token),
    id,
    Date.now() + 604800000
  ).run();

  return token;
}

async function getUser(db, token) {
  if (!token || token.length !== 64) return null;

  return db.prepare(`
    SELECT users.id, username, balance, level, xp,
    kills, deaths, wins, losses, inventory
    FROM users
    JOIN sessions ON users.id = sessions.user_id
    WHERE sessions.token = ?
    AND sessions.expires > ?
  `).bind(await tokenHash(token), Date.now()).first();
}

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  broadcast(data, except = null) {
    const message = JSON.stringify(data);

    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;

      try {
        ws.send(message);
      } catch {}
    }
  }

  players() {
    return this.ctx.getWebSockets()
      .map(ws => ws.deserializeAttachment())
      .filter(Boolean);
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/status") {
      return json({
        online: true,
        players: this.players().length
      });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return json({ error: "WebSocket required" }, 426);
    }

    const mode = url.searchParams.get("mode") || "competitive";
    const limit = mode === "wingman" ? 4 : 10;

    if (this.players().length >= limit) {
      return json({ error: "Server full" }, 409);
    }

    const username = request.headers.get("X-Player-Name");

    if (!username) {
      return json({ error: "Unauthorized" }, 401);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const id = crypto.randomUUID();

    const player = {
      id,
      username,
      team: this.players().length % 2 === 0 ? "CT" : "T",
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      hp: 100,
      weapon: "knife",
      crouch: false,
      lastUpdate: 0
    };

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(player);

    server.send(JSON.stringify({
      type: "welcome",
      id,
      player,
      players: this.players(),
      mode,
      sv_cheats: 0
    }));

    this.broadcast({
      type: "join",
      player
    }, server);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string") return;
    if (message.length > 4096) return;

    let data;

    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    const player = ws.deserializeAttachment();

    if (!player) return;

    switch (data.type) {
      case "ping":
        ws.send(JSON.stringify({
          type: "pong",
          time: data.time
        }));
        break;

      case "move": {
        const now = Date.now();

        if (now - player.lastUpdate < 40) return;

        const values = [
          data.x, data.y, data.z,
          data.yaw, data.pitch
        ];

        if (!values.every(Number.isFinite)) return;
        if (values.some(v => Math.abs(v) > 10000)) return;

        player.x = data.x;
        player.y = data.y;
        player.z = data.z;
        player.yaw = data.yaw;
        player.pitch = data.pitch;
        player.crouch = Boolean(data.crouch);
        player.lastUpdate = now;

        ws.serializeAttachment(player);

        this.broadcast({
          type: "move",
          player
        }, ws);

        break;
      }

      case "weapon":
        player.weapon = String(data.weapon || "knife")
          .slice(0, 40);

        ws.serializeAttachment(player);

        this.broadcast({
          type: "weapon",
          id: player.id,
          weapon: player.weapon
        });
        break;

      case "shoot":
        this.broadcast({
          type: "shoot",
          id: player.id,
          weapon: player.weapon
        }, ws);
        break;

      case "chat":
        this.broadcast({
          type: "chat",
          username: player.username,
          text: String(data.text || "").slice(0, 160)
        });
        break;

      case "command":
        ws.send(JSON.stringify({
          type: "console",
          text: "sv_cheats is disabled on public servers"
        }));
        break;
    }
  }

  async webSocketClose(ws, code, reason) {
    const player = ws.deserializeAttachment();

    if (player) {
      this.broadcast({
        type: "leave",
        id: player.id
      }, ws);
    }

    try {
      ws.close(code, reason);
    } catch {}
  }

  async webSocketError(ws) {
    const player = ws.deserializeAttachment();

    if (player) {
      this.broadcast({
        type: "leave",
        id: player.id
      }, ws);
    }

    try {
      ws.close(1011, "Connection error");
    } catch {}
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS
      });
    }

    try {
      if (path === "/") {
        return json({
          name: "STRIKEPOINT",
          version: "1.0.0 Beta",
          status: "online",
          accounts: Boolean(env.DB),
          multiplayer: Boolean(env.ROOMS)
        });
      }

      if (!env.DB) {
        return json({
          error: "Database not connected"
        }, 503);
      }

      const db = env.DB;

      if (path === "/api/check-username") {
        const username =
          (url.searchParams.get("username") || "").trim();

        if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
          return json({ available: false });
        }

        const user = await db.prepare(
          "SELECT id FROM users WHERE username = ?"
        ).bind(username).first();

        return json({ available: !user });
      }

      if (path === "/api/register"
          && request.method === "POST") {

        const data = await request.json();
        const username = String(data.username || "").trim();
        const password = String(data.password || "");

        if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
          return json({ error: "Invalid username" }, 400);
        }

        if (password.length < 8 || password.length > 128) {
          return json({ error: "Invalid password" }, 400);
        }

        const existing = await db.prepare(
          "SELECT id FROM users WHERE username = ?"
        ).bind(username).first();

        if (existing) {
          return json({ error: "Username taken" }, 409);
        }

        const salt = randomToken();
        const hash = await hashPassword(password, salt);

        const result = await db.prepare(`
          INSERT INTO users (username,password_hash,salt)
          VALUES (?,?,?)
          ON CONFLICT(username) DO NOTHING
        `).bind(username, hash, salt).run();

        if (!result.meta.changes) {
          return json({ error: "Username taken" }, 409);
        }

        return json({
          success: true,
          username,
          token: await createSession(
            db, result.meta.last_row_id
          )
        });
      }

      if (path === "/api/login"
          && request.method === "POST") {

        const data = await request.json();
        const username = String(data.username || "").trim();
        const password = String(data.password || "");

        if (password.length > 128) {
          return json({ error: "Invalid credentials" }, 401);
        }

        const user = await db.prepare(
          "SELECT * FROM users WHERE username = ?"
        ).bind(username).first();

        if (!user) {
          return json({ error: "Invalid credentials" }, 401);
        }

        const hash = await hashPassword(password, user.salt);

        if (hash !== user.password_hash) {
          return json({ error: "Invalid credentials" }, 401);
        }

        return json({
          success: true,
          username: user.username,
          token: await createSession(db, user.id)
        });
      }

      if (path === "/api/profile") {
        const token = request.headers
          .get("Authorization")
          ?.replace(/^Bearer /, "");

        const user = await getUser(db, token);

        if (!user) {
          return json({ error: "Unauthorized" }, 401);
        }

        return json(user);
      }

      if (path === "/api/matchmaking"
          && request.method === "POST") {

        const token = request.headers
          .get("Authorization")
          ?.replace(/^Bearer /, "");

        const user = await getUser(db, token);

        if (!user) {
          return json({ error: "Unauthorized" }, 401);
        }

        const data = await request.json();

        const mode = data.mode === "wingman"
          ? "wingman"
          : "competitive";

        const maps = ["mirage", "dust2", "inferno"];

        const map = maps.includes(data.map)
          ? data.map
          : "mirage";

        const room = `${mode}-${map}-1`;

        return json({
          success: true,
          room,
          mode,
          map,
          websocket: `wss://${url.host}/ws?room=${room}&mode=${mode}`
        });
      }

      if (path === "/ws") {
        if (!env.ROOMS) {
          return json({ error: "Rooms not connected" }, 503);
        }

        if (request.headers.get("Origin") !==
            "https://ilyushenka2379-sketch.github.io") {
          return json({ error: "Invalid origin" }, 403);
        }

        const token = url.searchParams.get("token");
        const user = await getUser(db, token);

        if (!user) {
          return json({ error: "Unauthorized" }, 401);
        }

        const room = url.searchParams.get("room") || "public";

        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(room)) {
          return json({ error: "Invalid room" }, 400);
        }

        const id = env.ROOMS.idFromName(room);
        const stub = env.ROOMS.get(id);

        const headers = new Headers(request.headers);
        headers.set("X-Player-Name", user.username);

        url.searchParams.delete("token");

        return stub.fetch(new Request(url.toString(), {
          method: "GET",
          headers
        }));
      }

      return json({ error: "Not found" }, 404);

    } catch (error) {
      console.error(error);
      return json({ error: "Server error" }, 500);
    }
  }
};
