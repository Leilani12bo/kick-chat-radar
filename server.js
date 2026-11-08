import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const CHANNEL_SLUG = (process.env.CHANNEL_SLUG || "deenthegreat").toLowerCase();
const clients = new Set();
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
      if ((message.channel || "").toLowerCase() === CHANNEL_SLUG) {
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
    webhookUrl: process.env.APP_BASE_URL ? `${process.env.APP_BASE_URL.replace(/\/$/, "")}/webhooks/kick` : null,
    webhookCount,
    lastEventAt,
    connectedBrowsers: clients.size,
    configured: Boolean(process.env.KICK_CLIENT_ID && process.env.KICK_CLIENT_SECRET && process.env.APP_BASE_URL)
  });
});

app.get("/api/messages", (_req, res) => res.json(latestMessages));

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

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Kick Chat Radar listening on ${PORT}`));
