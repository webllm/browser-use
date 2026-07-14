// Node.js clamps larger timer delays to 1 ms, which reverses timeout semantics.
export const MAX_BROWSER_TIMER_DELAY_MS = 2_147_483_647;
export const MAX_BROWSER_TIMER_DELAY_SECONDS = Math.floor(
  MAX_BROWSER_TIMER_DELAY_MS / 1000
);
