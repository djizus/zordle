export function renderEnd(won: boolean, finalWord: string): string {
  return `
    <div class="end">
      <p class="verdict ${won ? "win" : "lose"}">${won ? "Proof accepted" : "The lazy boss wins"}</p>
      <div class="reveal ${won ? "win" : "lose"}">${finalWord.toLowerCase()}</div>
      <div class="ribbon"><span class="pulse"></span>verified onchain</div>
      <div class="end-actions">
        <button id="play-again" class="btn-primary">Play again</button>
        <button id="share-result" class="btn-ghost">Share result</button>
      </div>
    </div>
  `;
}
