import { mkdirSync, writeFileSync } from "node:fs";
import { browserTargets, type BrowserTarget } from "./browser.config";
import {
  sessionBarrier,
  runBrowser,
  dismissNotices,
  launchBrowser,
  createBrowserContext,
} from "./browser-adapter";
import { query, pool } from "../lib/db";
const PROMPT =
  "What are three project management tools for a small business? Explain your choices.";
/**
 * `--inspect` is a selector-calibration aid. It opens the site, sends the sample
 * question, then writes a screenshot plus a JSON list of page elements that look
 * like assistant answers and of the Copy/Stop/Send-style buttons it saw while
 * the answer was generating and afterwards. Use it when a provider reports
 * "blocked"/"timeout" after a site redesign, then put the right selector into
 * BROWSER_SELECTOR_OVERRIDES (or src/worker/browser.config.ts).
 */
async function inspect(id: string, target: BrowserTarget) {
  const browser = await launchBrowser();
  try {
    const page = await (await createBrowserContext(browser)).newPage();
    page.setDefaultTimeout(8000);
    await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 20000 });
    const box = page.locator(target.input).filter({ visible: true }).first();
    for (let i = 0; i < 20 && !(await box.isVisible().catch(() => false)); i++) {
      await dismissNotices(page);
      await page.waitForTimeout(1000);
    }
    const composerFound = await box.isVisible().catch(() => false);
    const barrier = await sessionBarrier(page, {
      answer: target.answer,
      input: target.input,
      prompt: PROMPT,
    });
    const scan = () =>
      page.evaluate(() => {
        const shown = (e: Element) => (e as HTMLElement).getClientRects().length > 0;
        const attrs = (e: Element) =>
          Array.from(e.attributes)
            .filter((a) => /^(data-|id$|class$|role$|aria-label$|title$)/.test(a.name))
            .map((a) => `${a.name}="${a.value.slice(0, 80)}"`)
            .join(" ");
        const hint = (e: Element) => {
          const t = e.getAttribute("data-testid");
          if (t) return `[data-testid="${t}"]`;
          const d = Array.from(e.attributes).find(
            (a) => a.name.startsWith("data-") && a.value && a.value.length < 30,
          );
          if (d) return `[${d.name}="${d.value}"]`;
          if (e.id) return `[id^="${e.id.replace(/[0-9a-f-]{6,}.*$/i, "")}"]`;
          const c = (e.getAttribute("class") || "").split(/\s+/).find((x) => /^[a-z][a-z-]{3,}$/i.test(x));
          return c ? `${e.tagName.toLowerCase()}.${c}` : e.tagName.toLowerCase();
        };
        const looksLikeAnswer =
          /assistant|answer|response|message|markdown|prose|bot|\bai\b|reply|result/i;
        const containers = Array.from(document.querySelectorAll("body *"))
          .filter((e) => shown(e) && looksLikeAnswer.test(attrs(e)))
          .map((e) => ({ e, text: ((e as HTMLElement).innerText || "").trim() }))
          .filter((x) => x.text.length >= 30 && x.text.length <= 12000)
          .slice(0, 40)
          .map(({ e, text }) => ({
            selectorHint: hint(e),
            tag: e.tagName.toLowerCase(),
            attributes: attrs(e),
            textLength: text.length,
            preview: text.slice(0, 120),
          }));
        const buttons = Array.from(document.querySelectorAll('button,[role="button"]'))
          .filter(
            (e) =>
              shown(e) &&
              /copy|stop|send|submit|regenerate|rewrite|share|good|like|retry/i.test(attrs(e) + " " + ((e as HTMLElement).innerText || "")),
          )
          .slice(0, 30)
          .map((e) => ({ selectorHint: hint(e), attributes: attrs(e), text: ((e as HTMLElement).innerText || "").slice(0, 40) }));
        return { containers, buttons };
      });
    let during: Awaited<ReturnType<typeof scan>> | undefined;
    if (composerFound) {
      await box.fill(PROMPT);
      await box.press("Enter");
      await page.waitForTimeout(3000);
      during = await scan();
      await page.waitForTimeout(25000);
    }
    const after = await scan();
    mkdirSync("internal-debug", { recursive: true });
    const stamp = `${id}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await page.screenshot({ path: `internal-debug/inspect-${stamp}.png`, fullPage: true }).catch(() => {});
    const report = {
      provider: id,
      pageUrl: page.url(),
      title: await page.title().catch(() => ""),
      composerFound,
      barrier,
      configured: { input: target.input, answer: target.answer, completion: target.completion, stop: target.stop },
      whileGenerating: during,
      afterWait: after,
      screenshot: `internal-debug/inspect-${stamp}.png`,
    };
    writeFileSync(`internal-debug/inspect-${stamp}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ provider: id, composerFound, barrier, answerCandidates: after.containers.length, report: `internal-debug/inspect-${stamp}.json` }));
  } finally {
    await browser.close();
  }
}
async function main() {
  const submit = process.argv.includes("--submit");
  const doInspect = process.argv.includes("--inspect");
  const only = process.argv.find((a) => a.startsWith("--provider="))?.split("=")[1];
  for (const [id, target] of Object.entries(browserTargets)) {
    if (only && only !== id) continue;
    if (doInspect) {
      await inspect(id, target).catch((e) =>
        console.log(JSON.stringify({ provider: id, error: (e as Error).message.split("\n")[0] })),
      );
      continue;
    }
    let status = "error",
      reason = "",
      evidence;
    if (submit) {
      const r = await runBrowser(id, {
        prompt: PROMPT,
        signal: AbortSignal.timeout(90000),
      });
      status = r.status === "ok" ? "ready" : r.status;
      reason = r.errorReason || "";
      evidence = r.browserEvidence;
    } else {
      const browser = await launchBrowser();
      try {
        const page = await (await createBrowserContext(browser)).newPage();
        await page.goto(target.url, {
          waitUntil: "domcontentloaded",
          timeout: 20000,
        });
        const box = page.locator(target.input).filter({ visible: true }).first();
        for (let i = 0; i < 12 && !(await box.isVisible().catch(() => false)); i++) {
          await dismissNotices(page);
          await page.waitForTimeout(1000);
        }
        const barrier = await sessionBarrier(page, {
          answer: target.answer,
          input: target.input,
        });
        status =
          barrier?.status ||
          ((await box.isVisible().catch(() => false)) ? "input_found" : "blocked");
        reason =
          barrier?.reason ||
          "Input detection alone does not verify answer capture.";
      } catch (e) {
        reason = (e as Error).message.split("\n")[0];
      } finally {
        await browser.close();
      }
    }
    console.log(JSON.stringify({ provider: id, status, reason, evidence }));
    // Only a successful full answer probe establishes ready status.
    await query(
      "INSERT INTO browser_provider_health(provider_id,status,reason,checked_at) VALUES($1,$2,$3,now()) ON CONFLICT(provider_id) DO UPDATE SET status=$2,reason=$3,checked_at=now()",
      [id, status, reason],
    ).catch(() => {});
    if (status !== "ready" && submit) process.exitCode = 1;
  }
}
main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
