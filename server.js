import express from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const CHANNEL_SLUG = (process.env.CHANNEL_SLUG || "deenthegreat").toLowerCase();
const clients = new Set();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const HIGHLIGHTS_FILE = path.join(DATA_DIR, "highlights.json");
const EXTRA_CHANNELS_FILE = path.join(DATA_DIR, "extra-channels.json");
let savedHighlights = [];
let extraChannels = [];
let writeQueue = Promise.resolve();
async function loadExtraChannels() {
  try {
    const saved = JSON.parse(await fs.readFile(EXTRA_CHANNELS_FILE, "utf8"));
    extraChannels = Array.isArray(saved) ? saved.filter(item => item && item.slug && Number.isFinite(Number(item.broadcasterUserId))) : [];
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not load extra channels:", error);
  }
}
async function persistExtraChannels() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempFile = EXTRA_CHANNELS_FILE + ".tmp";
  await fs.writeFile(tempFile, JSON.stringify(extraChannels, null, 2), "utf8");
  await fs.rename(tempFile, EXTRA_CHANNELS_FILE);
}
async function loadHighlights() {
  try { savedHighlights = JSON.parse(await fs.readFile(HIGHLIGHTS_FILE, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") console.error("Could not load highlight history:", error); }
  if (!Array.isArray(savedHighlights)) savedHighlights = [];
}
async function persistHighlights() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempFile = HIGHLIGHTS_FILE + ".tmp";
  await fs.writeFile(tempFile, JSON.stringify(savedHighlights, null, 2), "utf8");
  await fs.rename(tempFile, HIGHLIGHTS_FILE);
}
function queuePersist() {
  writeQueue = writeQueue.then(persistHighlights).catch(error => console.error("Could not save highlight history:", error));
  return writeQueue;
}
await loadHighlights();
await loadExtraChannels();
let latestMessages = [];
let lastEventAt = null;
let webhookCount = 0;

app.post("/webhooks/kick", express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
  try {
    const raw = req.body?.toString("utf8") || "";
    const messageId = req.get("Kick-Event-Message-Id");
    const timestamp = req.get("Kick-Event-Message-Timestamp");
    const signature = req.get("Kick-Event-Signature");
    const eventType = req.get("Kick-Event-Type");

    if (!messageId || !timestamp || !signature || !eventType) {
      return res.status(400).send("Missing Kick webhook headers");
    }

    // Fetch Kick's current public key instead of pinning a key that may rotate.
    const keyResponse = await fetch("https://api.kick.com/public/v1/public-key");
    if (!keyResponse.ok) return res.status(503).send("Could not retrieve Kick public key");
    const keyData = await keyResponse.json();
    const publicKey = keyData.data?.public_key || keyData.public_key || keyData.data || keyData;
    const signingText = `${messageId}.${timestamp}.${raw}`;
    const valid = crypto.verify(
      "RSA-SHA256",
      Buffer.from(signingText, "utf8"),
      publicKey,
      Buffer.from(signature, "base64")
    );
    if (!valid) return res.status(401).send("Invalid webhook signature");

    if (eventType === "chat.message.sent") {
      const payload = JSON.parse(raw);
      const message = {
        id: payload.message_id || messageId,
        content: payload.content || "",
        username: payload.sender?.username || "Unknown viewer",
        channel: payload.broadcaster?.channel_slug || CHANNEL_SLUG,
        createdAt: payload.created_at || timestamp
      };

      // Guard against accidentally displaying events for a different channel.
      if ([CHANNEL_SLUG, ...extraChannels.map(channel => String(channel.slug).toLowerCase())].includes((message.channel || "").toLowerCase())) {
        latestMessages.unshift(message);
        latestMessages = latestMessages.slice(0, 100);
        lastEventAt = new Date().toISOString();
        webhookCount += 1;
        const frame = `data: ${JSON.stringify({ type: "chat", message })}\n\n`;
        for (const client of clients) client.write(frame);
      }
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).send("Webhook processing failed");
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/status", (_req, res) => {
  res.json({
    channel: CHANNEL_SLUG,
    monitoredChannels: [CHANNEL_SLUG, ...extraChannels.map(channel => channel.slug)],
    webhookUrl: process.env.APP_BASE_URL ? `${process.env.APP_BASE_URL.replace(/\/$/, "")}/webhooks/kick` : null,
    webhookCount,
    lastEventAt,
    connectedBrowsers: clients.size,
    configured: Boolean(process.env.KICK_CLIENT_ID && process.env.KICK_CLIENT_SECRET && process.env.APP_BASE_URL)
  });
});

app.get("/api/messages", (_req, res) => res.json(latestMessages));
app.get("/api/highlights", async (_req, res) => {
  await writeQueue;
  res.json(savedHighlights.slice().reverse());
});
app.post("/api/highlights", async (req, res) => {
  const item = req.body || {};
  if (!item.id || !item.content || !Array.isArray(item.matchedKeywords) || item.matchedKeywords.length === 0) {
    return res.status(400).json({ error: "A message ID, content, and matched keywords are required." });
  }
  const id = String(item.id);
  if (savedHighlights.some(entry => entry.id === id)) return res.json({ ok: true, duplicate: true });
  savedHighlights.push({
    id,
    username: String(item.username || "Unknown viewer").slice(0, 100),
    content: String(item.content).slice(0, 5000),
    channel: String(item.channel || CHANNEL_SLUG).slice(0, 100),
    createdAt: item.createdAt || new Date().toISOString(),
    matchedKeywords: item.matchedKeywords.map(value => String(value).slice(0, 60)).slice(0, 30),
    savedAt: new Date().toISOString()
  });
  if (savedHighlights.length > 10000) savedHighlights = savedHighlights.slice(-10000);
  await queuePersist();
  res.json({ ok: true });
});
app.get("/api/highlights.csv", async (_req, res) => {
  await writeQueue;
  const csvCell = value => '"' + String(value ?? "").replace(/"/g, '""') + '"';
  const rows = [["Saved At", "Message Time", "Channel", "Username", "Message", "Matched Keywords"], ...savedHighlights.map(item => [item.savedAt, item.createdAt, item.channel, item.username, item.content, (item.matchedKeywords || []).join(", ")])];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="kick-chat-radar-highlights-' + new Date().toISOString().slice(0,10) + '.csv"');
  res.send("\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n"));
});

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({ type: "history", messages: latestMessages })}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

app.post("/api/subscribe", async (_req, res) => {
  const { KICK_CLIENT_ID, KICK_CLIENT_SECRET, APP_BASE_URL, KICK_BROADCASTER_USER_ID } = process.env;
  if (!KICK_CLIENT_ID || !KICK_CLIENT_SECRET || !APP_BASE_URL || !KICK_BROADCASTER_USER_ID) {
    return res.status(400).json({
      error: "Add KICK_CLIENT_ID, KICK_CLIENT_SECRET, APP_BASE_URL, and KICK_BROADCASTER_USER_ID to your hosting environment first."
    });
  }

  try {
    const tokenResponse = await fetch("https://id.kick.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: KICK_CLIENT_ID,
        client_secret: KICK_CLIENT_SECRET
      })
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) {
      return res.status(502).json({ error: "Kick token request failed", details: tokenData });
    }

    const webhookUrl = `${APP_BASE_URL.replace(/\/$/, "")}/webhooks/kick`;
    const subscribeResponse = await fetch("https://api.kick.com/public/v1/events/subscriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        broadcaster_user_id: Number(KICK_BROADCASTER_USER_ID),
        method: "webhook",
        events: [{ name: "chat.message.sent", version: 1 }]
      })
    });
    const result = await subscribeResponse.json();
    if (!subscribeResponse.ok) {
      return res.status(502).json({ error: "Kick event subscription failed", details: result });
    }
    res.json({ ok: true, webhookUrl, result });
  } catch (error) {
    console.error("Subscribe error:", error);
    res.status(500).json({ error: "Could not subscribe to Kick events" });
  }
});


app.post("/api/subscribe-channel", async (req, res) => {
  const slug = String(req.body?.username || "").trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(slug)) {
    return res.status(400).json({ error: "Enter a valid Kick username." });
  }
  if (slug === CHANNEL_SLUG) return res.json({ ok: true, channel: slug, primary: true });
  if (extraChannels.some(channel => String(channel.slug).toLowerCase() === slug)) {
    return res.json({ ok: true, channel: slug, alreadySubscribed: true, message: "Second channel chat alerts are already enabled." });
  }

  const { KICK_CLIENT_ID, KICK_CLIENT_SECRET } = process.env;
  if (!KICK_CLIENT_ID || !KICK_CLIENT_SECRET || !process.env.APP_BASE_URL) {
    return res.status(400).json({ error: "Add your Kick app credentials and APP_BASE_URL in Render before enabling alerts for a second channel." });
  }

  try {
    const tokenResponse = await fetch("https://id.kick.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: KICK_CLIENT_ID,
        client_secret: KICK_CLIENT_SECRET
      })
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) {
      return res.status(502).json({ error: "Kick token request failed.", details: tokenData });
    }

    const channelResponse = await fetch("https://api.kick.com/public/v1/channels?slug=" + encodeURIComponent(slug), {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const channelData = await channelResponse.json();
    const channelList = Array.isArray(channelData.data) ? channelData.data : (channelData.data ? [channelData.data] : []);
    const channel = channelList.find(item => String(item.slug || "").toLowerCase() === slug) || channelList[0];
    const broadcasterUserId = Number(channel?.broadcaster_user_id);
    if (!channelResponse.ok || !Number.isFinite(broadcasterUserId) || broadcasterUserId <= 0) {
      return res.status(404).json({ error: "I couldn't find that Kick channel. Double-check the username and try again." });
    }

    const subscribeResponse = await fetch("https://api.kick.com/public/v1/events/subscriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        broadcaster_user_id: broadcasterUserId,
        method: "webhook",
        events: [{ name: "chat.message.sent", version: 1 }]
      })
    });
    const subscriptionData = await subscribeResponse.json();
    if (!subscribeResponse.ok) {
      return res.status(502).json({ error: "Kick couldn't create the second chat subscription.", details: subscriptionData });
    }

    extraChannels = [{ slug, broadcasterUserId }];
    await persistExtraChannels();
    res.json({ ok: true, channel: slug, message: "Second channel chat alerts are enabled." });
  } catch (error) {
    console.error("Second channel subscription error:", error);
    res.status(500).json({ error: "Could not enable second channel chat alerts." });
  }
});

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Kick Chat Radar listening on ${PORT}`));
