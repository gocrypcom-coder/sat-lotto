// sat-lotto/backend/merkle.js
const crypto = require('crypto');

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Erstellt den Merkle Root aus einer Liste von Ticket IDs.
 * @param {string[]} leaves - Liste der eindeutigen Ticket IDs (z.B. R-Hash_1, R-Hash_2).
 * @returns {string} Merkle Root Hash.
 */
function buildMerkle(leaves) {
  if (!leaves || leaves.length === 0) return sha256('');
  
  let nodes = leaves.map(sha256);

  while (nodes.length > 1) {
    const nextLayer = [];
    for (let i = 0; i < nodes.length; i += 2) {
      if (i + 1 === nodes.length) {
        // Ungerade Anzahl: Dupliziere den letzten Hash
        nextLayer.push(sha256(nodes[i] + nodes[i]));
      } else {
        // Konkateniere und hash (lexikografische Reihenfolge zur Sicherstellung des deterministischen Hashes)
        const combinedHash = nodes[i] < nodes[i + 1] 
          ? nodes[i] + nodes[i + 1] 
          : nodes[i + 1] + nodes[i];
        nextLayer.push(sha256(combinedHash));
      }
    }
    nodes = nextLayer;
  }
  return nodes[0];
}

module.exports = buildMerkle;
