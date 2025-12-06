// sat-lotto/backend/fisher-yates.js

/**
 * Führt einen deterministischen Fisher-Yates-Shuffle durch.
 * Der kombinierte Seed (Betreiber-Seed XOR Block-Hash) wird verwendet, 
 * um die Ziehung verifizierbar zu machen.
 * @param {string[]} array - Array der Ticket IDs.
 * @param {Buffer} seedHash - Der kombinierte Seed (Betreiber-Seed XOR Block-Hash).
 * @returns {string[]} Das deterministisch gemischte Array. Der Gewinner ist array[0].
 */
function fisherYates(array, seedHash) {
  const arr = [...array];
  const seed = BigInt(`0x${seedHash.toString('hex')}`);

  for (let i = arr.length - 1; i > 0; i--) {
    // Einfache deterministische Index-Generierung für den Shuffle
    const randValue = Number(seed % BigInt(i + 1));
    const j = (randValue + i) % (i + 1); 

    // Tausche Elemente i und j
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  // Das erste Element ist das gezogene Los
  return arr;
}

module.exports = fisherYates;
