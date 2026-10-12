# Five-question browser batch verification — 11 October 2026

This record applies to v1.4 and supersedes the older single-question release record.

| Check | Result |
| --- | --- |
| TypeScript | Passed |
| Unit/security/SQL tests | 40 passed across four suites |
| Local browser/UI tests | 11 passed: six capture tests, four full-flow viewport tests and one motion/chrome test |
| Production build | Passed, Next.js 16.4 webpack |
| Production HTTP smoke | Public config 401; authenticated config 200 with four browser candidates; four/six-question batches 400; retired custom-prompt endpoint 404; result URL recovery 200 |
| Scoped upgrade script | `bash -n deploy/upgrade-vps.sh` passed |
| LLM credential dependencies | No LLM API key references or provider HTTP API execution in runtime source/scripts |
| Responsive checks | Full input, collection, tabs and drawer flows at 360, 390, 768 and 1440 pixels; no horizontal overflow; long input wrapping tested |
| Visual inspection | Desktop input layout and mobile input/collection cards inspected |

## What the local checks establish

The SQL harness executes the actual migration repeatedly in PGlite. It exercises ownership, exact five-question validation, transaction rollback, idempotency, five-batch limits, IP allowance continuity, partial completion, timeout, refunds and zero-cost browser jobs. It dispatches all 20 rows through the actual worker processor with a test-only browser adapter: every question reaches four separate source runs, each recorded stage is readable from the database, and each saved answer belongs to its own question. It also checks that migration preserves old single-question answers and direct-brand-query labels.

PostgreSQL advisory locks and Redis/BullMQ transport are stubbed in this harness. It does not establish real VPS queue concurrency or performance. Production imports the actual browser adapter; the fixture adapter exists only in tests.

Playwright capture tests use controlled local HTML. They verify exact question submission, actual capture stage callbacks, completed assistant-only text, visible ordered-list numbering, scoped citations and SHA-256 provenance. They reject old/partial answers, hidden text, login barriers and free-use limits.

UI tests use explicit transport fixtures. They verify five blank manual fields without suggestion cards, all-five validation, the submitted batch payload, active collection stages, partially available answers, completion counts, per-question result/answer mapping, a failed source, brand-query labels, keyboard tabs/drawer and retained editable questions after the result URL changes. Detailed status cards collapse at completion and can be reopened. The production HTTP smoke uses only a local test bridge secret.

## Pending live acceptance

Public chatbot access and selectors remain unverified in this environment. The preceding browser release's live probe could not connect locally; a cloud-browser check was rejected by automatic approval review because its usage allowance was exhausted. No denied live action was retried through another surface.

Run the included `browser:probe --submit` on the user's VPS. Each source must return `ready` with a completed visible answer, real page URL, capture time and answer hash. A detected input alone is insufficient. Login, consent, verification, rate limit and timeout failures remain failures. Search activity/model identity are not inferred when not visibly reported. Four dependable, permanently free anonymous sources cannot be guaranteed.

Docker execution, real Redis/BullMQ processing, live provider generation, actual PostgreSQL load, the upgrade script on the user's VPS and deployment of this revision to Vercel were not executed here. Existing VPS tools and the team repository were not modified.

Internal screenshots, generated build files and test outputs are excluded from the source ZIP. The deployment guide includes expected outputs and the scoped upgrade script retains `.env`, volumes and port 8089, after source/database backups.

## v1.4.1 browser-worker fix verification

`tests/browser-providers.spec.ts` adds eleven fixtures modelled on real chat-site behaviour (terms footer beside a working composer, completion toolbar outside the answer node, hidden pre-existing nodes, welcome/terms dialog, login dialog never clicked, undismissable consent wall, Enter-does-not-submit, rich-text composer, limit wording inside the user's own question, page-level "Copy link", regular-Chrome User-Agent). Six of them failed on v1.4 and pass on v1.4.1; the original six capture tests still pass. `tests/browser-config.test.ts` covers selector overrides. These prove the adapter logic only: live site markup is still verified by `browser:probe --submit` on the VPS.
