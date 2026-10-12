import { test, expect, type Page } from "@playwright/test";
import { collectOnPage, createBrowserContext } from "../src/worker/browser-adapter";
import type { BrowserTarget } from "../src/worker/browser.config";

// Fixtures imitate patterns real chat sites use, so the adapter is exercised
// against realistic page behaviour rather than one idealised toy page.
const URL = "http://127.0.0.1:3000/local-provider-fixture";
const target: BrowserTarget = {
  url: URL,
  input: "textarea",
  answer: '[data-content="ai-message"]',
  completion: 'button[aria-label*="Copy" i]',
  stop: 'button[aria-label*="Stop" i]',
};
async function fixture(page: Page, html: string) {
  await page.route("**/local-provider-fixture", (r) =>
    r.fulfill({ contentType: "text/html", body: html }),
  );
}
const PROMPT = "Which accounting tools should small businesses consider?";
const ANSWER = "Acme is a solid accounting option for small teams and Beta is another good choice for freelancers";
const stages: string[] = [];
const run = (page: Page, ms = 15000, prompt = PROMPT, t = target) =>
  collectOnPage(page, t, {
    prompt,
    signal: AbortSignal.timeout(ms),
    onProgress: async (p) => {
      stages.push(p);
    },
  });

// Shared page script: user bubble + assistant answer streamed word by word.
const streamScript = (opts: { copyInside?: boolean; copyOutside?: boolean; stop?: boolean; noEnter?: boolean }) => `
const ta=document.querySelector('textarea'),thread=document.getElementById('thread');
${opts.noEnter ? "" : "ta.addEventListener('keydown',e=>{ if(e.key!=='Enter'||e.shiftKey) return; e.preventDefault(); send(); });"}
function send(){
  const u=document.createElement('div');u.dataset.content='user-message';u.textContent=ta.value;thread.append(u);ta.value='';
  const wrap=document.createElement('div');const a=document.createElement('div');a.dataset.content='ai-message';wrap.append(a);thread.append(wrap);
  ${opts.stop ? `const stop=document.createElement('button');stop.setAttribute('aria-label','Stop generating');stop.textContent='Stop';document.body.append(stop);` : ""}
  const words=${JSON.stringify(ANSWER)}.split(' ');let i=0;
  const t=setInterval(()=>{ a.textContent=words.slice(0,++i).join(' ');
    if(i>=words.length){ clearInterval(t);
      ${opts.stop ? "stop.remove();" : ""}
      ${opts.copyInside ? `a.insertAdjacentHTML('beforeend','<button aria-label="Copy">Copy</button>');` : ""}
      ${opts.copyOutside ? `const bar=document.createElement('div');bar.innerHTML='<button aria-label="Copy message">Copy</button>';wrap.append(bar);` : ""}
    } },120);
}
window.__send=send;`;

test("a normal 'you agree to the Terms' footer is not treated as a consent wall", async ({ page }) => {
  await fixture(page, `<main id="thread"></main><textarea placeholder="Message Copilot"></textarea>
    <footer>By messaging Copilot, you agree to our <a href="/t">Terms of Use</a> and <a href="/p">Privacy Policy</a>.</footer>
    <script>${streamScript({ copyInside: true })}</script>`);
  const r = await run(page);
  expect(r.errorReason).toBeUndefined();
  expect(r.status).toBe("ok");
  expect(r.answerText).toBe(ANSWER);
});

test("completion control that lives in the message toolbar (outside the answer node) is recognised", async ({ page }) => {
  await fixture(page, `<main id="thread"></main><textarea></textarea><script>${streamScript({ copyOutside: true })}</script>`);
  const r = await run(page);
  expect(r.status).toBe("ok");
  expect(r.answerText).toBe(ANSWER);
  expect(r.browserEvidence?.completion).toBe("answer_control");
});

test("a page-level 'Copy link' button is not mistaken for the answer's completion control", async ({ page }) => {
  await fixture(page, `<header><button aria-label="Copy link">Copy link</button></header><main id="thread"></main><textarea></textarea>
    <script>${streamScript({ stop: false })}
    // answer streams, pauses, then continues; only a stop-transition or answer control may finish it
    </script>`);
  const r = await run(page, 6000);
  expect(r.status).toBe("timeout");
  expect(r.answerText).toBeUndefined();
});

test("generation-stop transition alone still completes an answer", async ({ page }) => {
  await fixture(page, `<main id="thread"></main><textarea></textarea><script>${streamScript({ stop: true })}</script>`);
  const r = await run(page);
  expect(r.status).toBe("ok");
  expect(r.browserEvidence?.completion).toBe("generation_finished");
});

test("hidden pre-existing assistant-shaped nodes do not hide the real new answer", async ({ page }) => {
  await fixture(page, `<main id="thread"><div data-content="ai-message" style="display:none">template</div></main><textarea></textarea>
    <script>${streamScript({ copyInside: true })}</script>`);
  const r = await run(page);
  expect(r.status).toBe("ok");
  expect(r.answerText).toBe(ANSWER);
});

test("a dismissable welcome/terms dialog is acknowledged and the question is then sent", async ({ page }) => {
  await fixture(page, `<div role="dialog" aria-modal="true" id="dlg"><h2>Welcome to Duck.ai</h2>
    <p>By using this service you agree to the Terms of Use and Privacy Policy.</p><button id="ok">Agree and Continue</button></div>
    <main id="thread"></main><textarea style="display:none"></textarea>
    <script>document.getElementById('ok').onclick=()=>{document.getElementById('dlg').remove();document.querySelector('textarea').style.display='block'};
    ${streamScript({ copyInside: true })}</script>`);
  const r = await run(page);
  expect(r.status).toBe("ok");
  expect(r.answerText).toBe(ANSWER);
});

test("a login/sign-up dialog is never clicked through", async ({ page }) => {
  await fixture(page, `<div role="dialog" aria-modal="true"><h2>Log in or sign up to keep chatting</h2>
    <input type="email" placeholder="Email"><button id="c" onclick="window.__clicked=true">Continue</button></div><textarea style="display:none"></textarea>`);
  const r = await run(page, 6000);
  expect(r.status).toBe("blocked");
  expect(await page.evaluate(() => (window as unknown as { __clicked?: boolean }).__clicked)).toBeUndefined();
});

test("a consent wall that cannot be dismissed fails closed", async ({ page }) => {
  await fixture(page, `<p>By continuing you agree to the Terms and Privacy Policy.</p><textarea style="display:none"></textarea>`);
  const r = await run(page, 20000);
  expect(r.status).toBe("blocked");
  expect(r.answerText).toBeUndefined();
});

test("sends with the send button when Enter only inserts a new line", async ({ page }) => {
  await fixture(page, `<main id="thread"></main><textarea></textarea><button aria-label="Send message" id="s">Send</button>
    <script>${streamScript({ copyInside: true, noEnter: true })}
    document.getElementById('s').onclick=()=>window.__send();</script>`);
  const r = await run(page, 20000);
  expect(r.status).toBe("ok");
  expect(r.answerText).toBe(ANSWER);
  expect(await page.locator('[data-content="user-message"]').count()).toBe(1);
});

test("a rich-text (contenteditable) composer works", async ({ page }) => {
  await fixture(page, `<main id="thread"></main><div contenteditable="true" role="textbox" id="ed"></div>
    <script>const ed=document.getElementById('ed'),thread=document.getElementById('thread');
    ed.addEventListener('keydown',e=>{ if(e.key!=='Enter') return; e.preventDefault();
      const u=document.createElement('div');u.dataset.content='user-message';u.textContent=ed.innerText;thread.append(u);ed.textContent='';
      const a=document.createElement('div');a.dataset.content='ai-message';a.innerHTML=${JSON.stringify(ANSWER)}+'<button aria-label="Copy">Copy</button>';thread.append(a);});</script>`);
  const r = await run(page, 15000, PROMPT, { ...target, input: '[contenteditable="true"][role="textbox"]' });
  expect(r.status).toBe("ok");
  expect(r.answerText).toBe(ANSWER);
});

test("limit/verification wording inside the user's own question is not a barrier", async ({ page }) => {
  await fixture(page, `<main id="thread"></main><textarea></textarea><script>${streamScript({ copyInside: true })}</script>`);
  const r = await run(page, 15000, "How do I fix the 'too many requests' error and the 'verify you are human' loop in my API?");
  expect(r.status).toBe("ok");
  expect(r.answerText).toBe(ANSWER);
});

test("the browser identifies as regular Chrome, not HeadlessChrome", async ({ browser }) => {
  const page = await (await createBrowserContext(browser)).newPage();
  const ua = await page.evaluate(() => navigator.userAgent);
  expect(ua).not.toMatch(/Headless/i);
  expect(ua).toMatch(/Chrome\/\d+\.0\.0\.0/);
});
