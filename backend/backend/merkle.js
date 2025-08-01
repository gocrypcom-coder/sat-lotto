// backend/merkle.js
// Erzeugt einen einfachen Merkle-Root aus einem Array von Tickets

const { createHash } = require('crypto');

function hash(data) {
  return createHash('sha256').update(data).digest();
}

function buildMerkleTree(leaves) {
  if (leaves.length === 0) return Buffer.alloc(32).toString('hex');
  let level = leaves.map(l => hash(l));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i+1] || left; // odd count → duplicate
      next.push(hash(Buffer.concat([left, right])));
    }
    level = next;
  }
  return level[0].toString('hex');
}

module.exports = buildMerkleTree;
