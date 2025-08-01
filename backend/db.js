// backend/db.js
// Einfaches Interface zu eurer Datenbank (z.B. PostgreSQL, SQLite, MongoDB)

const { Pool } = require('pg'); // Beispiel: PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
});

module.exports = {
  // Gibt die aktuell aktive Runde zurück (pending oder countdown)
  async getActiveRound() {
    const res = await pool.query(
      `SELECT * FROM rounds WHERE state IN ('pending','countdown') ORDER BY id LIMIT 1`
    );
    return res.rows[0];
  },

  async getRoundInfo(round) {
    const res = await pool.query(
      `SELECT * FROM rounds WHERE id = $1`, [round]
    );
    return res.rows[0];
  },

  async updateRound(round, fields) {
    // Dynamisch UPDATE auf Basis von keys in `fields`
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

  async getCurrentPool(round) {
    const res = await pool.query(
      `SELECT SUM(amount) AS total FROM tickets WHERE round_id = $1`, [round]
    );
    return parseInt(res.rows[0].total, 10);
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
};
