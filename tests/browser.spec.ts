import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { collectOnPage, sessionBarrier } from "../src/worker/browser-adapter";
import { analyze } from "../src/lib/analysis";
import type { BrowserTarget } from "../src/worker/browser.config";
const target: BrowserTarget = {
  url: "http://127.0.0.1:3000/local-browser-fixture",
  input: "textarea",
  answer: '[data-role="assistant"]',
  completion: 'button[aria-label="Copy"]',
  stop: 'button[aria-label="Stop"]',
};
async function fixture(page: import("@playwright/test").Page, html: string) {
  await page.route("**/local-browser-fixture", (r) =>
    r.fulfill({ contentType: "text/html", body: html }),
  );
}
test("captures only a completed assistant answer, visible ordered recommendations and scoped citations", async ({
  page,
}) => {
  await fixture(
    page,
    `<a href="https://navigation.example">Navigation</a><textarea></textarea>
  <script>document.querySelector('textarea').addEventListener('keydown',e=>{if(e.key==='Enter'){
    const user=document.createElement('div');user.dataset.role='user';user.textContent=e.target.value;document.body.append(user);
    const answer=document.createElement('div');answer.dataset.role='assistant';answer.innerHTML='<ol><li><p><strong>Acme</strong>: helpful accounting software.</p></li><li>Beta: another option.</li></ol><a href="https://acme.com/reviews">Review evidence</a><button aria-label="Copy">Copy</button><span hidden>invisible invented answer</span><a hidden href="https://fake.example">Hidden citation</a>';document.body.append(answer);
  }});</script>`,
  );
  const stages: string[] = [];
  const result = await collectOnPage(page, target, {
    onProgress: async (phase) => {
      stages.push(phase);
    },
    prompt: "Which accounting tools should small businesses consider?",
    signal: AbortSignal.timeout(8000),
  });
  expect(result.status).toBe("ok");
  expect(stages).toEqual([
    "opening",
    "submitting",
    "waiting",
    "collecting",
    "collecting",
  ]);
  expect(await page.locator('[data-role="user"]').innerText()).toBe(
    "Which accounting tools should small businesses consider?",
  );
  expect(result.answerText).toContain("1. Acme");
  expect(result.answerText).not.toMatch(
    /Copy|Navigation|invisible|Which accounting/,
  );
  expect(result.citations).toEqual([
    {
      url: "https://acme.com/reviews",
      domain: "acme.com",
      title: "Review evidence",
    },
  ]);
  expect(result.browserEvidence?.answerHash).toBe(
    createHash("sha256").update(result.answerText!).digest("hex"),
  );
  expect(result.browserEvidence?.pageUrl).toBe(target.url);
  expect(result.modelReported).toBeUndefined();
  expect(result.webSearchUsed).toBe(false);
  expect(
    analyze(result.answerText!, result.citations!, {
      name: "Acme",
      aliases: [],
      domain: "acme.com",
    }).position,
  ).toBe(1);
});
test("refuses an existing assistant answer or a echoed prompt", async ({
  page,
}) => {
  await fixture(
    page,
    '<textarea></textarea><div data-role="assistant">An old assistant answer about the wrong business.<button aria-label="Copy">Copy</button></div>',
  );
  const result = await collectOnPage(page, target, {
    prompt: "Which services should I consider?",
    signal: AbortSignal.timeout(1800),
  });
  expect(result.status).toBe("timeout");
  expect(result.answerText).toBeUndefined();
});
test("does not score stable partial text without a completion signal", async ({
  page,
}) => {
  await fixture(
    page,
    `<textarea></textarea><script>document.querySelector('textarea').onkeydown=e=>{if(e.key==='Enter'){const d=document.createElement('div');d.dataset.role='assistant';d.textContent='Partial answer that might eventually recommend a brand.';document.body.append(d);}};</script>`,
  );
  const result = await collectOnPage(page, target, {
    prompt: "Which tools are useful?",
    signal: AbortSignal.timeout(4000),
  });
  expect(result.status).toBe("timeout");
  expect(result.browserEvidence).toBeUndefined();
});
test("stops at login, human verification or consent without submitting", async ({
  page,
}) => {
  await fixture(page, "<p>Sign in to continue</p><textarea></textarea>");
  const result = await collectOnPage(page, target, {
    prompt: "Do not submit this.",
    signal: AbortSignal.timeout(3000),
  });
  expect(result.status).toBe("blocked");
  expect(await page.locator("textarea").inputValue()).toBe("");
});
test("returns a free limit failure separately from a completed answer", async ({
  page,
}) => {
  await fixture(page, "<p>Daily limit reached</p><textarea></textarea>");
  const result = await collectOnPage(page, target, {
    prompt: "Do not submit this.",
    signal: AbortSignal.timeout(3000),
  });
  expect(result.status).toBe("rate_limited");
  expect(result.answerText).toBeUndefined();
});
test("challenge phrases inside an answer are not mistaken for a session barrier", async ({
  page,
}) => {
  await fixture(
    page,
    '<div style="display:none">Verify you are human</div><div data-role="assistant">The product can verify you are human.</div><textarea></textarea>',
  );
  await page.goto(target.url);
  expect(await sessionBarrier(page)).toBeNull();
});
