// backend/db.js

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
});

module.exports = {
  async getActiveRounds() {
    const res = await pool.query(
      `SELECT id, amount_sats, state, future_block FROM rounds WHERE state IN ('pending','countdown') ORDER BY id ASC`
    );
    return res.rows;
  },

  async createRound(amountSats) {
    const check = await pool.query(
        `SELECT id FROM rounds WHERE state = 'pending' AND amount_sats = $1`, [amountSats]
    );
    if (check.rows.length > 0) return check.rows[0].id;

    const res = await pool.query(
        `INSERT INTO rounds (state, amount_sats) VALUES ('pending', $1) RETURNING id`, [amountSats]
    );
    return res.rows[0].id;
  },

  async getRoundInfo(round) {
    const res = await pool.query(
      `SELECT id, state, future_block, amount_sats, seed FROM rounds WHERE id = $1`, [round]
    );
    return res.rows[0];
  },

  async updateRound(round, fields) {
    const sets = Object.keys(fields).map((k,i) => `"${k}" = $${i+2}`);
    const vals = Object.values(fields);
    await pool.query(
      `UPDATE rounds SET ${sets.join(', ')} WHERE id = $1`,
      [round, ...vals]
    );
  },

  async getParticipantCount(round) {
    const res = await pool.query(
      `SELECT COUNT(*) FROM tickets WHERE round_id = $1`, [round]
    );
    return parseInt(res.rows[0].count, 10);
  },

  async getTicketList(round) {
    const res = await pool.query(
      `SELECT ticket_id FROM tickets WHERE round_id = $1 ORDER BY ticket_id ASC`,
      [round]
    );
    return res.rows.map(r => r.ticket_id);
  },

  async getTicketInfoByTicketId(ticketId) {
    const res = await pool.query(
        `SELECT payout_address, amount FROM tickets WHERE ticket_id = $1`, [ticketId]
    );
    return res.rows[0]; 
  },

  async getCurrentPool(round) {
    const res = await pool.query(
      `SELECT SUM(amount) AS total FROM tickets WHERE round_id = $1`, [round]
    );
    return parseInt(res.rows[0].total, 10) || 0;
  },

  async storeSeed(round, seed, seedHash) {
    await pool.query(
      `INSERT INTO seeds (round_id, seed, seed_hash) VALUES ($1, $2, $3)`,
      [round, seed, seedHash]
    );
  },

  async recordWinners(round, data) {
    await pool.query(
      `INSERT INTO winners (round_id, winner, prize, fee, block_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [round, data.winner, data.prize, data.fee, data.blockHash]
    );
  },

  async createInvoice(roundId, lightningAddress, invoice, hash, amount, quantity, totalAmount) {
    const res = await pool.query(
      `INSERT INTO invoices (round_id, pubkey, payment_request, r_hash, amount, quantity, total_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending') RETURNING id`,
      [roundId, lightningAddress, invoice, hash, amount, quantity, totalAmount]
    );
    return res.rows[0].id;
  },

  async getPendingInvoices() {
    const res = await pool.query(
      `SELECT id, round_id, pubkey AS lightning_address, r_hash, amount, quantity, total_amount FROM invoices WHERE status = 'pending'`
    );
    return res.rows;
  },

  async settleInvoice(invoice) {
    await pool.query('BEGIN');
    try {
      await pool.query(
        `UPDATE invoices SET status = 'settled', settled_at = NOW() WHERE id = $1`,
        [invoice.id]
      );
      
      for (let i = 0; i < invoice.quantity; i++) {
        const uniqueTicketId = `${invoice.r_hash}_${i + 1}`;
        await pool.query(
          `INSERT INTO tickets (round_id, ticket_id, payout_address, amount) VALUES ($1, $2, $3, $4)`,
          [invoice.round_id, uniqueTicketId, invoice.lightning_address, invoice.amount]
        );
      }
      
      await pool.query('COMMIT');
    } catch (e) {
      await pool.query('ROLLBACK');
      throw e;
    }
  },

  async storeFailedEvent(event) {
    await pool.query(
      `INSERT INTO failed_events (event_json, reason) VALUES ($1, $2)`,
      [JSON.stringify(event), event.error || 'unknown']
    );
  },

  async storeFailedPayout(data) {
    await pool.query(
      `INSERT INTO failed_payouts (round_id, recipient, amount, reason)
       VALUES ($1, $2, $3, $4)`,
      [data.round, data.winner || 'platform', data.prize || data.fee, data.error]
    );
  }
};
