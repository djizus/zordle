export function renderEnd(won: boolean, finalWord: string): string {
  return `
    <div class="end">
      <p class="verdict ${won ? "win" : "lose"}">${won ? "You won" : "Game over"}</p>
      <div class="reveal ${won ? "win" : "lose"}">${finalWord.toLowerCase()}</div>
      <div class="end-actions">
        <button id="share-result" class="btn-ghost">Share</button>
        <button id="play-again" class="btn-primary">Play again</button>
      </div>
    </div>
  `;
}
