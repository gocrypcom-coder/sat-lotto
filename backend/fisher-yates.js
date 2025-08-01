// backend/fisher-yates.js
// Mischt ein Array basierend auf einem deterministischen Seed-Hash

function shuffle(array, seedBuffer) {
  const arr = array.slice();
  let j = 0;
  for (let i = arr.length - 1; i > 0; i--) {
    // Deterministische Pseudo-Random-Zahl aus seedBuffer
    j = seedBuffer[i % seedBuffer.length] % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = shuffle;
