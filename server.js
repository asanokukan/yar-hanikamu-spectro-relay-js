const express = require("express");

const app = express();
app.use(express.json({ limit: "1mb" }));

/* ============================================
   CONFIG
============================================ */

// Cloud Run provides PORT
const port = Number(process.env.PORT || 8080);

// SSE keepalive ping interval (prevents some proxies from closing idle streams)
const keepAliveMs = 15000;

/* ============================================
   State (in-memory)
============================================ */

let lastSample = null;
const sseClients = new Set(); // each item: { res, keepAliveTimer }

/* ============================================
   Basic routes
============================================ */

app.get("/", (_, res) => res.send("ok"));

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    hasSample: !!lastSample,
    clients: sseClients.size,
  });
});

/* ============================================
   Ingest: Rooftop -> Cloud
============================================ */

app.post("/ingest", (req, res) => {

  lastSample = req.body;

  const payload = `data: ${JSON.stringify(lastSample)}\n\n`;

  for (const client of sseClients) {
    client.res.write(payload);
  }

  // No content (fast)
  res.sendStatus(204);
});

/* ============================================
   Stream: Cloud -> Basement (SSE)
============================================ */

app.get("/stream", (req, res) => {
  // IMPORTANT: SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  // Helpful when behind proxies/CDNs (avoid buffering)
  res.setHeader("X-Accel-Buffering", "no");

  // CORS if you load /stream from a different origin in the browser
  // (If your basement page is served from the same Cloud Run URL, you can remove this.)
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Send a first newline to “open” the stream promptly
  res.write("\n");

  // Send latest sample immediately (if we have one)
  if (lastSample) {
    res.write(`data: ${JSON.stringify(lastSample)}\n\n`);
  }

  // Keepalive comments (":" lines are ignored by EventSource)
  const keepAliveTimer = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`);
  }, keepAliveMs);

  const client = { res, keepAliveTimer };
  sseClients.add(client);

  req.on("close", () => {
    clearInterval(keepAliveTimer);
    sseClients.delete(client);
  });
});

/* ============================================
   Start
============================================ */

app.listen(port, "0.0.0.0", () => {
  console.log(`Relay listening on port ${port}`);
});