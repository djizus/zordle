export function renderEnd(won: boolean, finalWord: string): string {
  return `
    <div class="end">
      <h2>${won ? "You won!" : "You lost"}</h2>
      <div class="reveal ${won ? "win" : "lose"}">${finalWord.toUpperCase()}</div>
      <button id="play-again">Play again</button>
    </div>
  `;
}
