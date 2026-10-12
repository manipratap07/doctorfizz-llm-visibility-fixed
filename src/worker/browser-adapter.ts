import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { createHash } from "node:crypto";
import type { ProviderResult, BrowserInput } from "../lib/types";
import {
  browserTargets,
  GENERIC_SEND,
  type BrowserTarget,
} from "./browser.config";

const visible = async (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .isVisible()
    .catch(() => false);

/* ------------------------------------------------------------------ */
/* Session barriers (login, limits, verification, consent)             */
/* ------------------------------------------------------------------ */

export type Barrier = {
  status: "blocked" | "rate_limited";
  reason: string;
  kind: "limit" | "login" | "verification" | "consent";
};
export type BarrierContext = {
  /** Selector of assistant answers; their text is never inspected. */
  answer?: string;
  /** Selector of the chat composer; consent walls only count when it is absent. */
  input?: string;
  /** The user's own question; echoed back by the page, so it is ignored. */
  prompt?: string;
  /** Set false once a question was sent (the composer may legitimately vanish). */
  consent?: boolean;
};
const LIMIT =
  /too many requests|rate[- ]limit(?:ed| reached| exceeded)|(?:daily|usage|free|message|chat) (?:limit|quota) (?:has been )?(?:reached|exceeded)|(?:reached|exceeded|hit) (?:your|the|today.?s) (?:daily |free |message |usage )?(?:limit|quota)/i;
const LOGIN =
  /(?:sign|log)[ -]?in (?:is )?(?:required|to (?:continue|keep|proceed|chat|use))|please (?:sign|log)[ -]?in|you (?:need|must|have) to (?:be )?(?:sign|log)(?:ged|ed)?[ -]?in|log in or sign up to (?:continue|keep)/i;
const VERIFY =
  /verify you are human|verifying you are human|unusual traffic|complete the captcha|performing security verification|security check to access|checking if the site connection is secure|are you a (?:robot|human)|press (?:and|&) hold/i;
// A consent WALL replaces the chat. A "by messaging X you agree to the Terms"
// footer next to a working composer is not a wall (that was the main reason
// every source used to report "blocked").
const CONSENT =
  /agree.{0,80}(?:terms|privacy)|(?:accept|allow) (?:all )?cookies|we use cookies|cookie (?:consent|preferences|settings|policy)|your privacy choices/i;

export async function sessionBarrier(
  page: Page,
  ctx: BarrierContext = {},
): Promise<Barrier | null> {
  const info = await page
    .evaluate(
      ({ answer, prompt }) => {
        const base =
          'script,style,noscript,[hidden],[aria-hidden="true"],textarea,input,[contenteditable="true"],[role="textbox"],[data-role="assistant"],[data-role="user"],[data-testid="assistant-message"],[data-testid="answer"],[data-testid="chat-message-assistant"],[data-content="ai-message"],[data-content="user-message"]';
        let exclude = base;
        if (answer) {
          try {
            document.createDocumentFragment().querySelector(answer);
            exclude = base + "," + answer;
          } catch {
            /* invalid provider selector: fall back to the built-in list */
          }
        }
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
        );
        const parts: string[] = [];
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const parent = node.parentElement;
          if (!parent || !node.textContent?.trim() || parent.closest(exclude))
            continue;
          // One native visibility check per text node instead of walking every ancestor.
          const shown = parent.checkVisibility
            ? parent.checkVisibility({ checkVisibilityCSS: true })
            : parent.getClientRects().length > 0;
          if (shown) parts.push(node.textContent);
        }
        const squash = (s: string) => s.replace(/\s+/g, " ").trim();
        let text = squash(parts.join(" "));
        const own = prompt ? squash(prompt) : "";
        if (own) text = text.split(own).join(" ");
        const challengeFrame = Array.from(
          document.querySelectorAll("iframe"),
        ).some((f) => {
          const r = f.getBoundingClientRect();
          return (
            /challenges\.cloudflare\.com|hcaptcha\.com\/captcha/i.test(
              f.src || "",
            ) &&
            r.width > 50 &&
            r.height > 50
          );
        });
        return { text, title: document.title || "", challengeFrame };
      },
      { answer: ctx.answer, prompt: ctx.prompt },
    )
    .catch(() => null);
  if (!info) return null;
  if (LIMIT.test(info.text))
    return {
      status: "rate_limited",
      kind: "limit",
      reason: "The free browser session reached its limit.",
    };
  if (LOGIN.test(info.text))
    return {
      status: "blocked",
      kind: "login",
      reason:
        "This browser session requires login, consent or human verification.",
    };
  if (
    info.challengeFrame ||
    VERIFY.test(info.text) ||
    /^(?:just a moment|attention required|checking your browser)/i.test(
      info.title,
    )
  )
    return {
      status: "blocked",
      kind: "verification",
      reason:
        "This browser session requires login, consent or human verification.",
    };
  if (ctx.consent !== false && CONSENT.test(info.text)) {
    const inputShown = ctx.input ? await visible(page, ctx.input) : false;
    if (!inputShown)
      return {
        status: "blocked",
        kind: "consent",
        reason:
          "This browser session requires login, consent or human verification.",
      };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Harmless interstitials (welcome / terms notice / cookie banner)     */
/* ------------------------------------------------------------------ */

const noticesEnabled = () => process.env.BROWSER_DISMISS_NOTICES !== "false";
/**
 * Acknowledges purely informational notices ("Agree and Continue", "Got it",
 * cookie "Accept") that some anonymous chat pages show before the composer.
 * It never touches sign-in, sign-up, account, social-login, payment or
 * subscription controls, and skips any dialog containing an email/password
 * field. Disable with BROWSER_DISMISS_NOTICES=false to restore strict
 * stop-on-consent behaviour. Returns the labels it clicked.
 */
export async function dismissNotices(page: Page): Promise<string[]> {
  return page
    .evaluate(() => {
      const SAFE =
        /^(?:agree(?:\s*(?:and|&)\s*continue)?|i agree|accept(?: all)?(?: cookies)?|allow all(?: cookies)?|got it|ok(?:ay)?|understood|i understand|continue|next|start(?: chatting| now)?|get started|close|dismiss|no,? thanks|maybe later|not now|skip)$/i;
      const SPECIFIC =
        /^(?:agree\s*(?:and|&)\s*continue|i agree|accept all(?: cookies)?|accept cookies|allow all(?: cookies)?)$/i;
      const UNSAFE =
        /sign|log\s?in|register|account|google|apple|microsoft|github|email|phone|subscribe|upgrade|premium|download|reject|decline|customi[sz]e|manage|setting|preference/i;
      const LOGINISH = /(?:sign|log)[ -]?(?:in|up)|create (?:an )?account|register/i;
      const CREDENTIALS =
        'input[type="email"],input[type="password"],input[type="tel"],input[autocomplete="username"]';
      const shown = (n: Element) =>
        n instanceof HTMLElement &&
        n.getClientRects().length > 0 &&
        getComputedStyle(n).visibility !== "hidden";
      const label = (b: Element) =>
        (
          b.getAttribute("aria-label") ||
          (b as HTMLElement).innerText ||
          b.getAttribute("title") ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim();
      const clicked: string[] = [];
      const buttons = (root: ParentNode) =>
        Array.from(
          root.querySelectorAll('button,[role="button"],a[role="button"]'),
        ).filter(shown);
      const containers = Array.from(
        document.querySelectorAll(
          '[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open],[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[class*="modal" i],[class*="popup" i],[class*="overlay" i],[class*="banner" i]',
        ),
      ).filter(shown);
      for (const c of containers) {
        if (clicked.length >= 2) break;
        if (c.querySelector(CREDENTIALS)) continue;
        if (LOGINISH.test((c as HTMLElement).innerText || "")) continue;
        const b = buttons(c).find((x) => {
          const l = label(x);
          return SAFE.test(l) && !UNSAFE.test(l);
        });
        if (b) {
          clicked.push(label(b));
          (b as HTMLElement).click();
        }
      }
      if (!clicked.length) {
        const b = buttons(document).find((x) => SPECIFIC.test(label(x)));
        if (b) {
          clicked.push(label(b));
          (b as HTMLElement).click();
        }
      }
      return clicked;
    })
    .catch(() => []);
}

/* ------------------------------------------------------------------ */
/* Reading the answer                                                  */
/* ------------------------------------------------------------------ */

export async function readVisibleAnswer(answer: Locator) {
  return answer.evaluate((root) => {
    const blocks = new Set([
      "P",
      "DIV",
      "LI",
      "H1",
      "H2",
      "H3",
      "H4",
      "H5",
      "H6",
      "PRE",
      "UL",
      "OL",
      "BLOCKQUOTE",
      "TABLE",
      "TR",
      "SECTION",
      "ARTICLE",
    ]);
    const walk = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
      if (!(node instanceof HTMLElement)) return "";
      if (
        node.matches(
          'button,input,textarea,script,style,svg,nav,[role="toolbar"],[aria-hidden="true"]',
        )
      )
        return "";
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return "";
      if (node.tagName === "BR") return "\n";
      let text = Array.from(node.childNodes).map(walk).join("");
      if (node.tagName === "LI" && node.parentElement?.tagName === "OL") {
        const siblings = Array.from(node.parentElement.children).filter(
          (n) => n.tagName === "LI",
        );
        const start = Number(node.parentElement.getAttribute("start") || 1);
        text = `${Number(node.getAttribute("value")) || start + siblings.indexOf(node)}. ${text.trim()}`;
      }
      // Keep table cells apart ("Acme $10", not "Acme$10").
      if (node.tagName === "TD" || node.tagName === "TH")
        return " " + text.trim() + " ";
      return blocks.has(node.tagName) ? "\n" + text + "\n" : text;
    };
    return walk(root)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  });
}

/**
 * Is the answer's own "finished" control showing? Chat UIs usually put Copy /
 * Regenerate in a toolbar next to the message, not inside the text node, so we
 * look in the answer and a few wrapper levels above it. The climb stops before
 * any container that also holds the composer, page chrome or another answer,
 * so a header "Copy link" button or an older message can never qualify.
 */
async function answerComplete(
  answer: Locator,
  completion: string,
  answerSelector: string,
) {
  return answer
    .evaluate(
      (el, [cSel, aSel]) => {
        const shown = (n: Element) =>
          n instanceof HTMLElement &&
          n.getClientRects().length > 0 &&
          getComputedStyle(n).visibility !== "hidden" &&
          // "Copy code" buttons inside code blocks are shown while streaming.
          !n.closest("pre") &&
          !/code/i.test(n.getAttribute("aria-label") || n.title || "");
        const composer =
          'textarea,[contenteditable="true"],[role="textbox"],input:not([type="hidden"])';
        let node: Element | null = el;
        for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
          if (
            depth > 0 &&
            (node.matches("body,html,main,header,nav,aside,form") ||
              node.querySelector(composer) ||
              node.querySelectorAll(aSel).length > 1)
          )
            break;
          if (Array.from(node.querySelectorAll(cSel)).some(shown)) return true;
        }
        return false;
      },
      [completion, answerSelector] as [string, string],
      { timeout: 2000 },
    )
    .catch(() => false);
}

const composerText = (box: Locator) =>
  box
    .evaluate(
      (el) =>
        el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement
          ? el.value
          : el.textContent || "",
      undefined,
      { timeout: 1000 },
    )
    .catch(() => "");
const countAnswers = (page: Page, selector: string) =>
  page
    .locator(selector)
    .filter({ visible: true })
    .count()
    .catch(() => 0);

/* ------------------------------------------------------------------ */
/* One question on one page                                            */
/* ------------------------------------------------------------------ */

export async function collectOnPage(
  page: Page,
  target: BrowserTarget,
  input: BrowserInput,
): Promise<ProviderResult> {
  const start = Date.now();
  const failure = (
    status: ProviderResult["status"],
    errorReason: string,
  ): ProviderResult => ({
    status,
    errorReason,
    webSearchUsed: false,
    latencyMs: Date.now() - start,
  });
  page.setDefaultTimeout(8000);
  try {
    input.signal.throwIfAborted();
    await input.onProgress?.(
      "opening",
      "Opening the public chat page.",
      target.url,
    );
    await page.goto(target.url, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    const ctx: BarrierContext = {
      answer: target.answer,
      input: target.input,
      prompt: input.prompt,
    };
    const box = page.locator(target.input).filter({ visible: true }).first();
    // Wait for the composer. Single-page apps hydrate late, notices may need
    // acknowledging first, and verification/consent screens may clear by themselves.
    const waitUntil = Date.now() + 25000;
    let barrier: Barrier | null = null;
    let ready = false;
    let dismissed = 0;
    // Soft barriers get a short grace period: a consent notice that could not be
    // acknowledged will not clear by itself, but a verification interstitial may.
    let softSince = 0;
    for (;;) {
      input.signal.throwIfAborted();
      if (noticesEnabled() && dismissed < 6)
        dismissed += (await dismissNotices(page)).length;
      barrier = await sessionBarrier(page, ctx);
      const hasInput = await box.isVisible().catch(() => false);
      // Login and limits are final. Verification is final once a composer is
      // showing; before that it may be a short interstitial, so keep waiting.
      if (
        barrier &&
        (barrier.kind === "limit" ||
          barrier.kind === "login" ||
          (hasInput && barrier.kind === "verification"))
      )
        return failure(barrier.status, barrier.reason);
      if (hasInput) {
        ready = true;
        break;
      }
      softSince = barrier ? softSince || Date.now() : 0;
      if (
        Date.now() >= waitUntil ||
        (barrier &&
          Date.now() - softSince >= (barrier.kind === "consent" ? 6000 : 15000))
      )
        break;
      await page.waitForTimeout(500);
    }
    if (!ready)
      return barrier
        ? failure(barrier.status, barrier.reason)
        : failure(
            "blocked",
            "No public chat input found. Run the VPS browser probe; this site may require login or updated selectors.",
          );
    const before = await countAnswers(page, target.answer);
    await input.onProgress?.(
      "submitting",
      "Sending your question.",
      page.url(),
    );
    await box.fill(input.prompt);
    // Rich editors occasionally ignore fill(); type it in instead (clearing first, never doubling).
    const probe = input.prompt.slice(0, 12);
    if (!(await composerText(box)).includes(probe)) {
      await box.click().catch(() => {});
      await page.keyboard.press("Control+A").catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});
      await page.keyboard.insertText(input.prompt);
    }
    await box.press("Enter");
    // Some UIs treat Enter as a newline. If nothing happened, use the send button once.
    let accepted = false;
    for (let i = 0; i < 8 && !accepted; i++) {
      await page.waitForTimeout(300);
      accepted =
        (await countAnswers(page, target.answer)) > before ||
        (await visible(page, target.stop)) ||
        !(await composerText(box)).trim();
    }
    if (!accepted && (await composerText(box)).includes(probe))
      await page
        .locator(target.send || GENERIC_SEND)
        .filter({ visible: true })
        .first()
        .click({ timeout: 2000 })
        .catch(() => {});
    await input.onProgress?.(
      "waiting",
      "Question sent; waiting for the provider to answer.",
      page.url(),
    );
    let receivingReported = false;
    let previous = "",
      stable = 0,
      stableRaw = 0,
      sawGenerating = false,
      tick = 0;
    while (!input.signal.aborted) {
      tick++;
      const answers = page.locator(target.answer).filter({ visible: true });
      const count = await answers.count();
      const answer = answers.last();
      const text =
        count > before ? await readVisibleAnswer(answer).catch(() => "") : "";
      // Limits/verification appear instead of an answer, so look hardest before text arrives.
      if (!text || tick % 4 === 0) {
        barrier = await sessionBarrier(page, { ...ctx, consent: false });
        if (barrier) return failure(barrier.status, barrier.reason);
        if (!text && tick % 4 === 0 && noticesEnabled() && dismissed < 6)
          dismissed += (await dismissNotices(page)).length;
      }
      if (text && !receivingReported) {
        receivingReported = true;
        await input.onProgress?.(
          "collecting",
          "Receiving answer text from this source.",
          page.url(),
        );
      }
      if (text.length > 60000)
        return failure("error", "The answer exceeded the capture limit.");
      const generating = await visible(page, target.stop);
      sawGenerating ||= generating;
      const complete =
        count > before &&
        (await answerComplete(answer, target.completion, target.answer));
      stableRaw = text && text === previous ? stableRaw + 1 : 0;
      stable = text && text === previous && !generating ? stable + 1 : 0;
      previous = text;
      if (
        text.trim().length >= 20 &&
        text.trim() !== input.prompt.trim() &&
        // Normal: text settled, generation not running, and a completion signal was seen.
        // Safety valve: the answer's own completion control is showing and the text has
        // been frozen ~9s, even if an unrelated "Stop" button keeps matching.
        ((stable >= 3 && (complete || sawGenerating)) ||
          (complete && stableRaw >= 12))
      ) {
        await input.onProgress?.(
          "collecting",
          "Collecting the completed answer and its visible citations.",
          page.url(),
        );
        const links = await answer.locator("a[href]").evaluateAll((ns) =>
          ns
            .filter(
              (n) =>
                (n as HTMLElement).getClientRects().length > 0 &&
                getComputedStyle(n).visibility !== "hidden",
            )
            .map((n) => ({
              url: (n as HTMLAnchorElement).href,
              title: (n.textContent || "").trim(),
            })),
        );
        const seen = new Set<string>();
        const citations = links.flatMap((link) => {
          try {
            const u = new URL(link.url);
            if (
              !["https:", "http:"].includes(u.protocol) ||
              u.username ||
              u.password ||
              u.hostname === new URL(target.url).hostname ||
              seen.has(u.href)
            )
              return [];
            seen.add(u.href);
            return [{ url: u.href, title: link.title, domain: u.hostname }];
          } catch {
            return [];
          }
        });
        const model = target.model
          ? await page
              .locator(target.model)
              .filter({ visible: true })
              .first()
              .innerText()
              .catch(() => "")
          : "";
        const searchSeen = target.search
          ? await visible(page, target.search)
          : false;
        return {
          status: "ok",
          answerText: text,
          citations,
          modelReported: model.slice(0, 100) || undefined,
          webSearchUsed: searchSeen,
          latencyMs: Date.now() - start,
          browserEvidence: {
            captureMethod: "visible_dom",
            adapterVersion: "browser-2",
            pageUrl: page.url(),
            capturedAt: new Date().toISOString(),
            answerHash: createHash("sha256").update(text).digest("hex"),
            completion: complete ? "answer_control" : "generation_finished",
            searchObservation: searchSeen ? "confirmed" : "not_confirmed",
          },
        };
      }
      await page.waitForTimeout(750);
    }
    return failure(
      "timeout",
      "No completed browser answer before the deadline; partial text was not scored.",
    );
  } catch (e) {
    return failure(
      input.signal.aborted ? "timeout" : "error",
      input.signal.aborted
        ? "Browser deadline exceeded."
        : "Public browser UI could not be captured. " +
            (e instanceof Error
              ? e.message.split("\n")[0].slice(0, 200)
              : "Unknown browser error"),
    );
  }
}

/* ------------------------------------------------------------------ */
/* Browser / context                                                   */
/* ------------------------------------------------------------------ */

/**
 * A normal-looking, honest browser profile. Playwright's headless default
 * advertises "HeadlessChrome" in the User-Agent, which many sites refuse
 * outright, so present the same Chromium build under its regular UA string.
 * No fingerprint spoofing is done and verification screens are still treated as
 * failures. Optional environment settings:
 *   BROWSER_USER_AGENT, BROWSER_TIMEZONE, BROWSER_PROXY_SERVER/_USERNAME/_PASSWORD,
 *   BROWSER_HEADED=true (needs a display, e.g. xvfb-run), BROWSER_CHANNEL,
 *   BROWSER_EXECUTABLE_PATH.
 */
export async function createBrowserContext(
  browser: Browser,
): Promise<BrowserContext> {
  const major = browser.version().split(".")[0] || "141";
  return browser.newContext({
    locale: "en-US",
    timezoneId: process.env.BROWSER_TIMEZONE || undefined,
    userAgent:
      process.env.BROWSER_USER_AGENT ||
      `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });
}
export async function launchBrowser(): Promise<Browser> {
  const executablePath = process.env.BROWSER_EXECUTABLE_PATH || undefined;
  const common = {
    headless: process.env.BROWSER_HEADED !== "true",
    timeout: 15000,
    args: ["--disable-dev-shm-usage"],
    proxy: process.env.BROWSER_PROXY_SERVER
      ? {
          server: process.env.BROWSER_PROXY_SERVER,
          username: process.env.BROWSER_PROXY_USERNAME || undefined,
          password: process.env.BROWSER_PROXY_PASSWORD || undefined,
        }
      : undefined,
  };
  if (executablePath) return chromium.launch({ ...common, executablePath });
  try {
    // The "chromium" channel is the full browser in new headless mode, which
    // behaves like a real Chrome far more than the stripped headless shell.
    return await chromium.launch({
      ...common,
      channel: process.env.BROWSER_CHANNEL || "chromium",
    });
  } catch {
    return chromium.launch(common);
  }
}
export async function runBrowser(
  id: string,
  input: BrowserInput,
): Promise<ProviderResult> {
  const target = browserTargets[id];
  if (!target)
    return {
      status: "error",
      errorReason: "Unknown browser target.",
      webSearchUsed: false,
      latencyMs: 0,
    };
  let browser: Browser | undefined;
  try {
    input.signal.throwIfAborted();
    browser = await launchBrowser();
    const context = await createBrowserContext(browser);
    const page = await context.newPage();
    const abort = () => {
      void browser?.close().catch(() => {});
    };
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      return await collectOnPage(page, target, input);
    } finally {
      input.signal.removeEventListener("abort", abort);
    }
  } catch (e) {
    return {
      status: input.signal.aborted ? "timeout" : "error",
      errorReason: input.signal.aborted
        ? "Browser deadline exceeded."
        : "Browser could not start. Check the worker image and browser installation. " +
          (e instanceof Error ? e.message.split("\n")[0].slice(0, 160) : ""),
      webSearchUsed: false,
      latencyMs: 0,
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}
