/**
 * Baileys WhatsApp backend — Express server, Heroku-ready.
 *
 * Single in-memory session. Auth state persisted to ./auth (ephemeral on Heroku).
 * Protect every endpoint with x-api-key header.
 */
const express = require("express");
const cors = require("cors");
const pino = require("pino");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "change-me";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const AUTH_DIR = path.join(process.cwd(), "auth");

// ---- in-memory state -------------------------------------------------------
const state = {
  sock: null,
  connecting: false,
  connected: false,
  qrDataUrl: null,
  pairingCode: null,
  user: null,
  chats: new Map(), // jid -> { id, name, unreadCount, lastMessage, timestamp }
  messages: new Map(), // jid -> Message[]
};

const logger = pino({ level: "warn" });

function recordMessage(jid, m) {
  if (!state.messages.has(jid)) state.messages.set(jid, []);
  const arr = state.messages.get(jid);
  arr.push(m);
  if (arr.length > 200) arr.splice(0, arr.length - 200);
  const chat = state.chats.get(jid) || { id: jid, name: jid.split("@")[0], unreadCount: 0 };
  chat.lastMessage = m.body;
  chat.timestamp = m.timestamp;
  if (!m.fromMe) chat.unreadCount = (chat.unreadCount || 0) + 1;
  state.chats.set(jid, chat);
}

function extractText(msg) {
  const m = msg.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ""
  );
}

async function startSocket() {
  if (state.connecting) return;
  state.connecting = true;
  state.qrDataUrl = null;
  state.pairingCode = null;

  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: authState,
    logger,
    printQRInTerminal: false,
    browser: ["WA Console", "Chrome", "1.0.0"],
    syncFullHistory: false,
  });

  state.sock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      try {
        state.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      } catch (e) {
        console.error("QR encode failed", e);
      }
    }
    if (connection === "open") {
      state.connected = true;
      state.connecting = false;
      state.qrDataUrl = null;
      state.pairingCode = null;
      state.user = sock.user
        ? { id: sock.user.id, name: sock.user.name || sock.user.verifiedName || null }
        : null;
      console.log("✅ WhatsApp connected as", state.user?.id);
    }
    if (connection === "close") {
      state.connected = false;
      state.connecting = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log("❌ Disconnected:", code, "loggedOut?", loggedOut);
      if (!loggedOut) {
        setTimeout(() => startSocket().catch(console.error), 2000);
      } else {
        // wipe creds so a new QR can be generated
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
        state.user = null;
      }
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;
    for (const msg of messages) {
      if (!msg.message) continue;
      const jid = msg.key.remoteJid;
      if (!jid) continue;
      const body = extractText(msg);
      recordMessage(jid, {
        id: msg.key.id,
        from: jid,
        body,
        timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
        fromMe: !!msg.key.fromMe,
      });
    }
  });

  sock.ev.on("chats.upsert", (chats) => {
    for (const c of chats) {
      const existing = state.chats.get(c.id) || {};
      state.chats.set(c.id, {
        id: c.id,
        name: c.name || existing.name || c.id.split("@")[0],
        unreadCount: c.unreadCount || existing.unreadCount || 0,
        lastMessage: existing.lastMessage,
        timestamp: existing.timestamp || Number(c.conversationTimestamp) || 0,
      });
    }
  });

  sock.ev.on("contacts.upsert", (contacts) => {
    for (const c of contacts) {
      const existing = state.chats.get(c.id);
      if (existing && c.notify) existing.name = c.notify;
    }
  });
}

// ---- HTTP API --------------------------------------------------------------
const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "25mb" }));

app.use((req, res, next) => {
  if (req.path === "/" || req.path === "/health") return next();
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.get("/", (_req, res) => res.send("Baileys server up"));
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/status", (_req, res) => {
  res.json({
    connected: state.connected,
    connecting: state.connecting,
    user: state.user,
    qr: state.qrDataUrl,
    pairingCode: state.pairingCode,
  });
});

app.post("/api/session/start", async (_req, res) => {
  try {
    if (!state.sock || !state.connected) await startSocket();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/session/logout", async (_req, res) => {
  try {
    if (state.sock) {
      try { await state.sock.logout(); } catch {}
    }
    state.sock = null;
    state.connected = false;
    state.connecting = false;
    state.user = null;
    state.qrDataUrl = null;
    state.pairingCode = null;
    state.chats.clear();
    state.messages.clear();
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/session/pairing", async (req, res) => {
  try {
    const phone = String(req.body.phone || "").replace(/\D/g, "");
    if (!phone) return res.status(400).json({ error: "phone required" });
    if (!state.sock) await startSocket();
    // Wait briefly for sock to be ready
    for (let i = 0; i < 20 && !state.sock; i++) await new Promise((r) => setTimeout(r, 200));
    if (state.sock.authState.creds.registered) {
      return res.status(400).json({ error: "already registered — logout first" });
    }
    const code = await state.sock.requestPairingCode(phone);
    state.pairingCode = code;
    res.json({ pairingCode: code });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/chats", (_req, res) => {
  const chats = [...state.chats.values()]
    .filter((c) => c.id.endsWith("@s.whatsapp.net") || c.id.endsWith("@g.us"))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 100);
  res.json({ chats });
});

app.get("/api/messages/:jid", (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const messages = (state.messages.get(jid) || []).slice(-50);
  // mark read
  const c = state.chats.get(jid);
  if (c) c.unreadCount = 0;
  res.json({ messages });
});

app.post("/api/send/text", async (req, res) => {
  try {
    if (!state.connected) return res.status(409).json({ error: "not connected" });
    const { jid, text } = req.body;
    if (!jid || !text) return res.status(400).json({ error: "jid and text required" });
    const sent = await state.sock.sendMessage(jid, { text: String(text) });
    const id = sent?.key?.id || "";
    recordMessage(jid, { id, from: state.user?.id || "me", to: jid, body: text, timestamp: Math.floor(Date.now() / 1000), fromMe: true });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/send/media", async (req, res) => {
  try {
    if (!state.connected) return res.status(409).json({ error: "not connected" });
    const { jid, base64, mime, filename, caption } = req.body;
    if (!jid || !base64 || !mime) return res.status(400).json({ error: "jid, base64, mime required" });
    const buffer = Buffer.from(base64, "base64");
    let payload;
    if (mime.startsWith("image/")) payload = { image: buffer, caption, mimetype: mime };
    else if (mime.startsWith("video/")) payload = { video: buffer, caption, mimetype: mime };
    else if (mime.startsWith("audio/")) payload = { audio: buffer, mimetype: mime, ptt: false };
    else payload = { document: buffer, mimetype: mime, fileName: filename || "file", caption };
    const sent = await state.sock.sendMessage(jid, payload);
    res.json({ ok: true, id: sent?.key?.id || "" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Baileys server listening on :${PORT}`);
  console.log(`🔑 API_KEY ${API_KEY === "change-me" ? "is DEFAULT — set one!" : "configured"}`);
  // Auto-start socket on boot if creds exist
  if (fs.existsSync(path.join(AUTH_DIR, "creds.json"))) {
    startSocket().catch(console.error);
  }
});
