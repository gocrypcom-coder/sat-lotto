// backend/server.js

const express = require("express");
const fs = require("fs");
const { simpleSigner, relayPool } = require("nostr-tools");
const Joi = require("joi");
const crypto = require("crypto");
const db = require("./db");
const buildMerkle = require("./merkle");
const fisherYates = require("./fisher-yates");
const promClient = require("prom-client");
const helmet = require("helmet");
const lnurl = require("lnurl-client");
const fetch = require("node-fetch"); 
const { Greenlight } = require("@blockstream/greenlight"); 

const app = express();
app.use(express.json());
app.use(helmet());

// TICKET-KONSTANTEN
const TICKET_TIERS = [100, 1000, 10000];
const MIN_PARTICIPANTS = 10;
const BLOCKS_TO_WAIT = 144; 

// Prometheus Metrics (initialisiert)
const collectDefaultMetrics = promClient.collectDefaultMetrics;
collectDefaultMetrics();
const drawCounter = new promClient.Counter({ name: "sat_lotto_draws_total", help: "Anzahl durchgeführter Ziehungen" });
const invoiceCounter = new promClient.Counter({ name: "sat_lotto_invoices_created_total", help: "Anzahl erstellter Lightning-Rechnungen" });
const responseTimeHistogram = new promClient.Histogram({ name: "response_time_histogram", help: "API response time in seconds", buckets: [0.1, 0.5, 1, 2, 5] });

// --- GREENLIGHT & PUBLIC API ---
let greenlightNode;
const BITCOIN_EXPLORER_API = "https://blockstream.info/api"; 

async function initializeGreenlight() {
  const mnemonic = process.env.GREENLIGHT_MNEMONIC;
  const network = process.env.BITCOIN_NETWORK || "testnet";

  if (!mnemonic) throw new Error("GREENLIGHT_MNEMONIC muss gesetzt sein.");
  
  greenlightNode = new Greenlight(mnemonic, {
      network,
      node: {
          key: Buffer.from(process.env.NODE_ID, 'hex'), 
          host: 'https://greenlight.blockstream.com/' 
      }
  });

  await greenlightNode.start();
  console.log(`Greenlight Node gestartet auf ${network}. Node ID: ${greenlightNode.id}`);
}

async function getBlockCount() {
    const response = await fetch(`${BITCOIN_EXPLORER_API}/block/tip/height`);
    if (!response.ok) throw new Error("Konnte Blockhöhe nicht von Explorer abrufen.");
    return parseInt(await response.text(), 10);
}

async function getBlockHash(height) {
    const response = await fetch(`${BITCOIN_EXPLORER_API}/block-height/${height}`);
    if (!response.ok) throw new Error(`Konnte Block Hash für Höhe ${height} nicht abrufen.`);
    return await response.text(); 
}
// --- ENDE GREENLIGHT & PUBLIC API ---

// Nostr Relay-Pool
const relays = [ "wss://relay.damus.io", "wss://nostr-pub.wellorder.net" ];
const pool = relayPool();
relays.forEach(url => pool.addRelay(url));

// Joi-Schemata
const statusSchema = Joi.object({
  round: Joi.number().integer().min(1).required()
});
const ticketSchema = Joi.array().items(Joi.string()).min(MIN_PARTICIPANTS).required();
const buyTicketSchema = Joi.object({
  lightningAddress: Joi.string().email().required(),
  ticketPrice: Joi.number().valid(...TICKET_TIERS).required(),
  quantity: Joi.number().integer().min(1).max(100).required(),
  round: Joi.number().integer().min(1).required()
});

async function publishWithRetry(event, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            await pool.publish(event);
            return;
        } catch (e) {
            if (i < retries - 1) await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    await db.storeFailedEvent(event);
}

// NEUER ENDPUNKT: Ticket kaufen
app.post("/api/ticket/buy", async (req, res) => {
  const end = responseTimeHistogram.startTimer();
  try {
    const { lightningAddress, ticketPrice, quantity, round } = await buyTicketSchema.validateAsync(req.body);
    const info = await db.getRoundInfo(round);
    const totalAmount = ticketPrice * quantity;

    if (!info || info.state === 'done' || info.amount_sats !== ticketPrice) {
      return res.status(400).json({ error: "Runde nicht aktiv oder Einsatz falsch." });
    }
    
    // 1. Lightning Invoice generieren (Nutzt Greenlight)
    const memo = `SatLotto R${round}: ${quantity} Lose x ${ticketPrice} Sats`;
    
    const invoice = await greenlightNode.invoice({
        amount_msat: totalAmount * 1000,
        label: `R${round}_${lightningAddress}_${Date.now()}`,
        description: memo
    });

    const { bolt11, payment_hash } = invoice;

    // 2. Pending Invoice in DB speichern
    const invoiceId = await db.createInvoice(round, lightningAddress, bolt11, payment_hash, ticketPrice, quantity, totalAmount);
    invoiceCounter.inc();

    res.json({
      round,
      invoiceId,
      paymentRequest: bolt11,
      amountSats: totalAmount,
      memo
    });
  } catch (err) {
    console.error("Buy ticket error:", err);
    res.status(400).json({ error: err.message });
  } finally {
    end();
  }
});

// Global Status Endpoint (Für dynamische Blockhöhe im Frontend)
app.get("/api/global/status", async (req, res) => {
  try {
    const currentBlock = await getBlockCount(); 
    res.json({
      success: true,
      currentBlock: currentBlock.toLocaleString('de-DE'), 
    });
  } catch (err) {
    res.status(500).json({ success: false, error: "Konnte Blockhöhe nicht abrufen." });
  }
});

app.get("/api/round/:round/status", async (req, res) => {
  const end = responseTimeHistogram.startTimer();
  try {
    const { round } = await statusSchema.validateAsync(req.params);
    const info = await db.getRoundInfo(round);
    if (!info) return res.status(404).json({ error: "Runde nicht gefunden." });

    const count = await db.getParticipantCount(round);
    const currentBlock = await getBlockCount();
    const currentPool = await db.getCurrentPool(round);

    res.json({
      round,
      state: info.state,
      ticketPrice: info.amount_sats,
      participantCount: count,
      jackpot: Math.floor(currentPool * 0.99),
      minParticipants: MIN_PARTICIPANTS,
      currentBlock,
      futureBlock: info.future_block || null
    });
  } catch (err) {
    console.error("Status endpoint error:", err);
    res.status(400).json({ error: err.message });
  } finally {
    end();
  }
});

async function commitSeed(round) {
  try {
    const seed = crypto.randomBytes(32);
    const hash = crypto.createHash("sha256").update(seed).digest("hex");
    await db.storeSeed(round, seed.toString("hex"), hash);
    
    // Achtung: Hier muss die Seed-Speicherung auf die Rounds-Tabelle umgestellt werden, da die Seeds-Tabelle entfernt wurde.
    // Da wir die Rounds-Tabelle nicht überladen wollen, verwenden wir stattdessen die updateRound-Funktion.
    await db.updateRound(round, { seed: seed.toString("hex"), seed_hash: hash });

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

async function runCommitment(round, futureBlock) {
  try {
    const tickets = await db.getTicketList(round);
    await ticketSchema.validateAsync(tickets);
    const merkleRoot = buildMerkle(tickets);
    await db.updateRound(round, { state: "countdown", futureBlock, merkleRoot });
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
    const blockHash = await getBlockHash(futureBlock); 
    
    const seedBuffer = Buffer.from(seed, "hex");
    const blockHashBuffer = Buffer.from(blockHash, "hex");
    const combinedSeed = Buffer.alloc(seedBuffer.length);
    for (let i = 0; i < seedBuffer.length; i++) {
      combinedSeed[i] = seedBuffer[i] ^ blockHashBuffer[i % blockHashBuffer.length];
    }
    const seedHash = crypto.createHash("sha256").update(combinedSeed).digest();
    
    const tickets = await db.getTicketList(round);
    const winningTicketId = fisherYates(tickets, seedHash)[0];
    
    const winnerInfo = await db.getTicketInfoByTicketId(winningTicketId);
    const winnerAddress = winnerInfo.payout_address;
    
    const poolSats = await db.getCurrentPool(round);
    const prize = Math.floor(poolSats * 0.99);
    const fee = poolSats - prize;
    
    await db.recordWinners(round, { winner: winnerAddress, prize, fee, blockHash });
    await db.updateRound(round, { state: "done" });
    
    await payoutWinner(winnerAddress, prize, round); 
    await payoutPlatform(fee); // Platzhalter
    drawCounter.inc();
    
    const event = {
      kind: 30001,
      content: JSON.stringify({ round, winningTicketId, winnerAddress, prize, fee, blockHash }),
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

// Automatische Auszahlung an Gewinner via LNURL-pay (Nutzt Greenlight)
async function payoutWinner(winnerLightningAddress, prize, round) {
  try {
    const { pr } = await lnurl.requestInvoice({
      lnUrlOrAddress: winnerLightningAddress,
      sats: prize,
      comment: `SatLotto Prize Round ${round}`
    });

    await greenlightNode.pay({
        bolt11: pr,
        amount_msat: prize * 1000,
        max_feerate: 10000 
    });

    console.log(`Sofortige Auszahlung von ${prize} Sats an ${winnerLightningAddress} erfolgreich.`);

  } catch (err) {
    console.error(`Failed to pay winner ${winnerLightningAddress} for round ${round}:`, err);
    await db.storeFailedPayout({ winner: winnerLightningAddress, prize, round, error: err.message });
  }
}

async function payoutPlatform(fee) {
    console.log(`Platform fee of ${fee} sats reserved.`);
    // TODO: Implementiere Greenlight Auszahlung an die Plattform-Adresse
}

// SCHEDULER: Zahlungs-Checker
setInterval(async () => {
  try {
    const pendingInvoices = await db.getPendingInvoices();
    for (const inv of pendingInvoices) {
      try {
        const { paid_at, amount_received_msat } = await greenlightNode.fetchInvoice({
          payment_hash: inv.r_hash
        });

        if (paid_at) {
          const settledAmount = Math.floor(parseInt(amount_received_msat, 10) / 1000); 
          
          if (settledAmount >= inv.total_amount) { 
            await db.settleInvoice(inv); 
          } else {
             console.warn(`Invoice ${inv.id} bezahlt, aber falscher Betrag.`);
          }
        }
      } catch (err) {
        console.error(`Error looking up invoice ${inv.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error("Payment scheduler error:", err);
    await db.storeFailedEvent({ error: err.message, scheduler: "payment" });
  }
}, 10_000);

// SCHEDULER: Runden-Checker
setInterval(async () => {
  try {
    const activeRounds = await db.getActiveRounds();
    
    for (const round of activeRounds) {
        const count = await db.getParticipantCount(round.id);

        if (round.state === "pending" && count >= MIN_PARTICIPANTS) {
            const cb = await getBlockCount(); 
            const fb = cb + BLOCKS_TO_WAIT;
            await commitSeed(round.id);
            await runCommitment(round.id, fb);
        } 
        
        else if (round.state === "countdown") {
            const cb = await getBlockCount();
            if (cb >= round.future_block) {
                await runDraw(round.id);
                await db.createRound(round.amount_sats);
            }
        }
    }
  } catch (err) {
    console.error("Draw scheduler error:", err);
    await db.storeFailedEvent({ error: err.message, scheduler: "draw" });
  }
}, 60_000);

app.get("/metrics", async (req, res) => {
    res.set("Content-Type", promClient.register.contentType);
    res.end(await promClient.register.metrics());
});

app.get("/health", (req, res) => res.send("OK"));

// Server starten und Greenlight initialisieren
app.listen(3001, () => {
    console.log(`Backend läuft auf Port 3001`);
    initializeGreenlight().catch(err => {
        console.error("Fehler beim Starten von Greenlight:", err);
        process.exit(1);
    });
});
