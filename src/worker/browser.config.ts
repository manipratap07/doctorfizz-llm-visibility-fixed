export type BrowserTarget = {
  url: string;
  input: string;
  answer: string;
  completion: string;
  stop: string;
  /** Optional send button; used only if Enter did not submit the question. */
  send?: string;
  model?: string;
  search?: string;
};
// Shared generic controls. `i` makes attribute matching case-insensitive, so
// "Copy", "copy" and "Copy message" all match.
const COPY =
  'button[aria-label*="Copy" i],button[title*="Copy" i],button[data-testid*="copy" i]';
const STOP =
  'button[aria-label*="Stop" i],button[title*="Stop" i],button[data-testid*="stop" i]';
/** Generic send-button selector, used when a target does not define its own. */
export const GENERIC_SEND =
  'button[data-testid*="send" i],button[data-testid*="submit" i],button[aria-label*="Send" i],button[aria-label*="Submit" i],button[type="submit"]';
// Candidate UI selectors. browser:probe --submit is the VPS acceptance gate.
// Deliberately no whole-page/article fallback: an unknown UI must fail closed.
// The `answer` selectors must match ONLY the assistant's reply, never the
// user's own message. If a site changes, override a single field without a
// rebuild via BROWSER_SELECTOR_OVERRIDES (see applyOverrides below) and use
// `npm run browser:probe -- --inspect` to discover the right selector.
const base: Record<string, BrowserTarget> = {
  copilot: {
    url: "https://copilot.microsoft.com/",
    input:
      'textarea#userInput,textarea[data-testid="composer-input"],textarea[placeholder*="Message" i],textarea[placeholder*="Ask" i],textarea[aria-label*="Message" i],textarea[aria-label*="Ask" i]',
    answer:
      '[data-content="ai-message"],[data-testid="ai-message"],[data-testid="chat-message-assistant"],[data-testid="assistant-message"],[data-role="assistant"]',
    completion: `${COPY},button[aria-label*="Good response" i],button[aria-label*="Thumbs up" i]`,
    stop: STOP,
    send: GENERIC_SEND,
  },
  "perplexity-web": {
    url: "https://www.perplexity.ai/",
    input:
      '#ask-input,div[contenteditable="true"][role="textbox"],textarea[placeholder*="Ask" i],textarea[placeholder*="anything" i],div[contenteditable="true"]',
    answer:
      'div[id^="markdown-content-"],[data-testid="answer"],[data-testid="assistant-message"]',
    completion: `${COPY},button[aria-label*="Rewrite" i]`,
    stop: STOP,
    send: GENERIC_SEND,
    search: '[data-testid="search-sources"]',
  },
  "grok-web": {
    url: "https://grok.com/",
    input:
      'textarea[aria-label*="Ask" i],textarea[placeholder*="Ask" i],textarea[placeholder*="What do you want" i],div.ProseMirror[contenteditable="true"],div[contenteditable="true"]',
    answer:
      '.response-content-markdown,.message-bubble[data-role="assistant"],[data-testid="assistant-message"],[data-role="assistant"]',
    completion: `${COPY},button[aria-label*="Regenerate" i]`,
    stop: STOP,
    send: GENERIC_SEND,
  },
  duckai: {
    url: "https://duck.ai/",
    input:
      'textarea[name="user-prompt"],textarea[placeholder*="Ask" i],textarea[placeholder*="Message" i],textarea[aria-label*="Message" i],textarea[aria-label*="prompt" i],textarea',
    answer:
      '[data-testid="assistant-message"],[data-role="assistant"],[data-message-author-role="assistant"],[data-testid*="assistant" i]',
    completion: COPY,
    stop: STOP,
    send: GENERIC_SEND,
  },
};
const FIELDS = [
  "url",
  "input",
  "answer",
  "completion",
  "stop",
  "send",
  "model",
  "search",
] as const;
/**
 * BROWSER_SELECTOR_OVERRIDES='{"duckai":{"answer":"div.my-answer"}}'
 * Lets the VPS owner repair one selector after a site redesign without
 * rebuilding the image. Unknown providers/fields and non-strings are ignored,
 * and an invalid JSON value is ignored rather than crashing the worker.
 */
export function applyOverrides(
  targets: Record<string, BrowserTarget>,
  raw = process.env.BROWSER_SELECTOR_OVERRIDES,
): Record<string, BrowserTarget> {
  if (!raw) return targets;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return targets;
  }
  if (!parsed || typeof parsed !== "object") return targets;
  const out: Record<string, BrowserTarget> = {};
  for (const [id, t] of Object.entries(targets)) {
    const o = (parsed as Record<string, unknown>)[id];
    const next = { ...t } as Record<string, string | undefined>;
    if (o && typeof o === "object")
      for (const f of FIELDS) {
        const v = (o as Record<string, unknown>)[f];
        if (typeof v === "string" && v.trim()) next[f] = v.trim();
      }
    out[id] = next as BrowserTarget;
  }
  return out;
}
export const browserTargets: Record<string, BrowserTarget> =
  applyOverrides(base);
