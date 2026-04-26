import { letterStatus, type PastGuess } from "./board";

const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];

export function renderKeyboard(past: PastGuess[]): string {
  const status = letterStatus(past);
  const rows: string[] = [];
  for (let r = 0; r < ROWS.length; r++) {
    const keys: string[] = [];
    if (r === 2) {
      keys.push(`<button class="key wide" data-key="ENTER">Enter</button>`);
    }
    for (const ch of ROWS[r]) {
      const cls = status.get(ch) ?? "";
      keys.push(
        `<button class="key ${cls}" data-key="${ch}">${ch}</button>`,
      );
    }
    if (r === 2) {
      keys.push(`<button class="key wide" data-key="BACK">Del</button>`);
    }
    rows.push(`<div class="kb-row">${keys.join("")}</div>`);
  }
  return `<div class="keyboard">${rows.join("")}</div>`;
}

// Translate a physical or virtual key event into one of:
//   "letter:a" / "ENTER" / "BACK" / null
export function normalizeKey(raw: string): string | null {
  const lower = raw.toLowerCase();
  if (lower === "enter") return "ENTER";
  if (lower === "backspace" || lower === "back") return "BACK";
  if (lower.length === 1 && lower >= "a" && lower <= "z") {
    return `letter:${lower}`;
  }
  return null;
}
