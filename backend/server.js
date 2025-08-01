// backend/server.js

const express = require("express");
const fs = require("fs");
const { Client } = require("bitcoin-core");
const { simpleSigner, relayPool } = require("nostr-tools");
const Joi = require("joi");
const crypto = require("crypto");
const db = require("./db");
const buildMerkle = require("./merkle");
const fisherYates = require("./fisher-yates");
const promClient = require("prom-client");
const helmet = require("helmet");
const { LndClient } = require("lightning"); // LND gRPC-Client

const app = express();
app.use(express.json());
app.use(helmet()); // Sicherheits-Header

// Prometheus Metrics
const collectDefaultMetrics = promClient.collectDefaultMetrics;
collectDefaultMetrics();
const drawCounter = new promClient.Counter({
  name: "sat_lotto_draws_total",
  help: "Anzahl durchgeführter Ziehungen"
});
const ticketGauge = new promClient.Gauge({
  name: "sat_lotto_tickets_total",
  help: "Aktuelle Teilnehmerzahl der Runde"
});
const responseTimeHistogram = new promClient.Histogram({
  name: "response_time_histogram",
  help: "API response time in seconds",
  buckets: [0.1, 0.5, 1, 2, 5]
});

// LND-Client
const lnd = new LndClient({
  cert: fs.readFileSync("/root/.lnd/tls.cert"),
  macaroon: fs.readFileSync("/root/.lnd/data/chain/bitcoin/mainnet/admin.macaroon"),
  socket: "lnd:10009"
});

// RPC-Client
const rpcNetwork = process.env.RPC_NETWORK || "mainnet";
const rpc = new Client({
  network: rpcNetwork,
  username: fs.readFileSync("/run/secrets/bitcoind-rpcauth").toString().split(":")[0],
  password: fs.readFileSync("/run/secrets/bitcoind-rpcauth").toString().split(":")[1],
  port: rpcNetwork === "mainnet" ? 8332 : 18332, // Testnet-Port
  host: "bitcoind"
});

// Nostr Relay-Pool
const relays = [
  "wss://relay.damus.io",
  "wss://nostr-pub.wellorder.net",
  "wss://relay.nostr.band",
  "wss://nostr-2.zebedee.cloud"
];
const pool = relayPool();
relays.forEach(url => pool.addRelay(url));

// Joi-Schemata
const statusSchema = Joi.object({
  round: Joi.number().integer().min(1).required()
});
const ticketSchema = Joi.array().items(Joi.string()).max(100).required();

// Retry-Logik für Nostr-Publishing
async function publishWithRetry(event, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.publish(event);
      return;
    } catch (e) {
      console.error(`Nostr publish failed (attempt ${i + 1}):`, e);
      if (i < retries - 1) await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  console.error("Nostr publish failed after retries, storing in dead-letter queue");
  try {
    await db.storeFailedEvent(event);
  } catch (err) {
    console.error("Failed to store event in dead-letter queue:", err);
  }
}

// Status-Endpoint
app.get("/api/round/:round/status", async (req, res) => {
  const end = responseTimeHistogram.startTimer();
  try {
    const { round } = await statusSchema.validateAsync(req.params);
    const info = await db.getRoundInfo(round);
    const count = await db.getParticipantCount(round);
    const currentBlock = await rpc.getBlockCount();
    ticketGauge.set(count);
    res.json({
      round,
      participantCount: count,
      currentBlock,
      futureBlock: info.futureBlock || null
    });
  } catch (err) {
    console.error("Status endpoint error:", err);
    res.status(400).json({ error: err.message });
  } finally {
    end();
  }
});

// Commit-Reveal: Seed-Hash publizieren
async function commitSeed(round) {
  try {
    const seed = crypto.randomBytes(32);
    const hash = crypto.createHash("sha256").update(seed).digest("hex");
    await db.storeSeed(round, seed.toString("hex"), hash);
    const event = {
      kind: 30002,
      content: JSON.stringify({ round, seedHash: hash }),
      created_at: Math.floor(Date.now() / 1000),
      pubkey: process.env.NOSTR_PUBKEY
    };
    event.id = await simpleSigner(event, fs.readFileSync("/run/secrets/nostr-private-key").toString());
    await publishWithRetry(event);
  } catch (err) {
    console.error("Commit seed error:", err);
    await db.storeFailedEvent({ round, error: err.message });
  }
}

// Commitment: Merkle-Root & futureBlock publizieren
async function runCommitment(round, futureBlock) {
  try {
    const tickets = await db.getTicketList(round);
    await ticketSchema.validateAsync(tickets);
    const merkleRoot = buildMerkle(tickets);
    await db.updateRound(round, { state: "countdown", futureBlock });
    const event = {
      kind: 30000,
      content: JSON.stringify({ round, merkleRoot, futureBlock }),
      created_at: Math.floor(Date.now() / 1000),
      pubkey: process.env.NOSTR_PUBKEY
    };
    event.id = await simpleSigner(event, fs.readFileSync("/run/secrets/nostr-private-key").toString());
    await publishWithRetry(event);
  } catch (err) {
    console.error("Run commitment error:", err);
    await db.storeFailedEvent({ round, error: err.message });
  }
}

// Ziehung: Gewinner, Auszahlung, Fee
async function runDraw(round) {
  try {
    const info = await db.getRoundInfo(round);
    const { futureBlock, seed } = info;
    const blockHash = await rpc.getBlockHash(futureBlock);
    const seedBuffer = Buffer.from(seed, "hex");
    const blockHashBuffer = Buffer.from(blockHash, "hex");
    const combinedSeed = Buffer.alloc(seedBuffer.length);
    for (let i = 0; i < seedBuffer.length; i++) {
      combinedSeed[i] = seedBuffer[i] ^ blockHashBuffer[i % blockHashBuffer.length];
    }
    const seedHash = crypto.createHash("sha256").update(combinedSeed).digest();
    const tickets = await db.getTicketList(round);
    await ticketSchema.validateAsync(tickets);
    const winner = fisherYates(tickets, seedHash)[0];
    const poolSats = await db.getCurrentPool(round);
    const prize = Math.floor(poolSats * 0.99);
    const fee = poolSats - prize;
    await db.recordWinners(round, { winner, prize, fee, blockHash });
    await db.updateRound(round, { state: "done" });
    await payoutWinner(winner, prize, round);
    await payoutPlatform(fee);
    drawCounter.inc();
    const event = {
      kind: 30001,
      content: JSON.stringify({ round, winner, prize, fee, blockHash }),
      created_at: Math.floor(Date.now() / 1000),
      pubkey: process.env.NOSTR_PUBKEY
    };
    event.id = await simpleSigner(event, fs.readFileSync("/run/secrets/nostr-private-key").toString());
    await publishWithRetry(event);
  } catch (err) {
    console.error("Run draw error:", err);
    await db.storeFailedEvent({ round, error: err.message });
  }
}

// Auszahlung an Gewinner via LND
async function payoutWinner(winner, prize, round) {
  try {
    const invoice = await lnd.addInvoice({
      value: prize,
      memo: `SatLotto Prize Round ${round}`
    });
    const event = {
      kind: 4,
      content: JSON.stringify({ invoice: invoice.paymentRequest }),
      created_at: Math.floor(Date.now() / 1000),
      pubkey: process.env.NOSTR_PUBKEY,
      tags: [["p", winner]]
    };
    event.id = await simpleSigner(event, fs.readFileSync("/run/secrets/nostr-private-key").toString());
    await publishWithRetry(event);
    console.log(`Sent invoice for ${prize} sats to winner ${winner} for round ${round}`);
  } catch (err) {
    console.error(`Failed to payout winner ${winner} for round ${round}:`, err);
    await db.storeFailedPayout({ winner, prize, round, error: err.message });
  }
}

// Auszahlung an Plattform
async function payoutPlatform(fee) {
  // TODO: Implementiere Auszahlung via LND oder Whirlpool für Privacy
  // Empfehlung: Nutze Tor für anonyme Verbindungen (z. B. via tor npm-Paket)
  console.log(`Payout to platform: ${fee} sats`);
}

// Scheduler: alle 60s aktive Runde prüfen
setInterval(async () => {
  try {
    const round = await db.getActiveRound();
    if (!round) return;
    const count = await db.getParticipantCount(round);
    const info = await db.getRoundInfo(round);
    if (count >= 10 && info.state === "pending") {
      const cb = await rpc.getBlockCount();
      const fb = cb + 144;
      await commitSeed(round);
      await runCommitment(round, fb);
    } else if (info.state === "countdown") {
      const cb = await rpc.getBlockCount();
      if (cb >= info.futureBlock) {
        await runDraw(round);
      }
    }
  } catch (err) {
    console.error("Scheduler error:", err);
    await db.storeFailedEvent({ error: err.message });
  }
}, 60_000);

// Metrics-Endpoint
app.get("/metrics", async (req, res) => {
  res.set("Content-Type", promClient.register.contentType);
  res.end(await promClient.register.metrics());
});

// Health-Endpoint
app.get("/health", (req, res) => res.send("OK"));

// Server starten
const port = 3001;
app.listen(port, () => console.log(`Backend läuft auf Port ${port}`));
