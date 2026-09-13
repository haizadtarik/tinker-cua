# TinkerCUA

A local web chat that asks GPT-6 Astra to build an Arduino LED circuit in a separate, visible Tinkercad browser. The user signs in directly in Tinkercad. The agent works through screenshots and validated mouse/keyboard actions.

The supported recipe is one Arduino Uno, one external LED, and a 330 Ω series resistor on D8, with adjustable blink timing. First requests create a **new empty Circuits project**; follow-ups inspect and modify that conversation’s existing project. There is no prepared-circuit fallback, iframe, browser sidebar, or simulated Tinkercad canvas.

**Prototype status:** the exact acceptance scenario passed in a fresh conversation: one uninterrupted build from an empty real Tinkercad project, followed by a same-project 1000 → 500 ms edit. Both runs observed the external LED lit and unlit. Exact timing was inspected in code, not measured. See [verification results](docs/verification.md).

## Run locally

Requirements: Node.js 22+, installed Google Chrome, an OpenAI key with access to `gpt-6-astra`, and a Tinkercad account. The primary tested environment is macOS with Chrome; Windows/Linux startup paths are included but unverified.

```sh
npm install
cp .env.example .env
# Set OPENAI_API_KEY in .env. Keep an existing .env rather than overwriting it.
npm run dev
```

Open **http://127.0.0.1:4317** on this computer. Use the same hostname and browser for the conversation. For compiled execution, use `npm run build` then `npm start`.

This backend must run on the same computer as the visible browser. An ordinarily hosted remote backend cannot open a headed browser on the user’s computer. No remote streaming or cloud deployment is included.

## Use it

1. Send: “Build an Arduino with an external LED blinking one second on, one second off.”
2. Read the short confirmation. Unsupported requests are declined before launching Tinkercad.
3. TinkerCUA opens its dedicated Chrome window. If needed, complete login/MFA/CAPTCHA there. Never enter credentials into chat.
4. Click **I’m logged in**. This checks for the actual authenticated dashboard; clicking early leaves the agent paused. Screenshots and agent actions remain blocked during the handoff.
5. Watch the real browser build from the empty canvas. The chat reports observed milestones and separates work performed, evidence, and unresolved checks.
6. Send “Make it blink twice as fast.” The agent reads the current code and halves both delays in the **same project** (1000 → 500 ms in the acceptance scenario).

**Stop** aborts the pending model request and prevents subsequent actions. Chrome stays open. Wait for the request to settle before editing or submitting the next instruction; an already-issued mouse event cannot be undone. Continuation starts with a fresh observation and preserves components. If a model safety check appears, review and acknowledge it before using its Continue button; stale pending actions are discarded.

## Sessions and recovery

The chat window follows Chrome’s actual size. Conversation history scrolls inside the panel; the message box and session controls fit laptop and mobile windows. `npm run test:layout` checks native Chrome resizing and short/mobile viewports using mocked session responses, without changing the saved conversation.

- `.browser-profile/` is the dedicated Tinkercad profile. Chrome starts normally and Playwright attaches over loopback CDP. Login cookies persist between browser launches. TinkerCUA does not use `GMAIL_USERNAME` or `GMAIL_PASSWORD`.
- Keep one backend instance per profile. If an earlier TinkerCUA Chrome window owns the profile, close that dedicated window and retry. Personal Chrome profiles are separate.
- One persistent cookie-bound conversation owns the browser until the saved local conversation is reset. Refreshing the original chat preserves history. Another browser/private window cannot access or control it. Click **New session** from an ownership error to start fresh, or run `npm run chat` locally to reopen the saved conversation in its dedicated chat window. A new session ends the previous chat’s control.
- Chat history, ownership and the current project are saved locally in `.session.json`. A backend restart restores the same conversation with actions stopped; send the next instruction to inspect and continue. Click **+ New session** in the chat header to start a new conversation. This preserves Tinkercad login and every existing circuit, archives the previous conversation under `artifacts/sessions/`, and clears the active project association. Stop any active request and wait for it to finish before resetting. No backend restart or file cleanup is needed.
- Closing the managed browser preserves the project URL within the running backend. Send the next instruction to reopen it. Session expiry returns to manual login.
- If construction stalls, the agent asks for help with a reason and a specific action, then pauses observation and actions. Make the requested fix in Tinkercad and click **Continue**, or reply in chat. Continue inspects a fresh screenshot of the current editor without reloading it, keeps the original task and existing components, and starts a new bounded run. A partially built circuit is not reported as a validated working circuit. Repeated actions, model turns, runtime and action counts are bounded.

## Verification

Session/help update: 45 unit tests cover ownership rotation, run exclusion, human-help pauses, continuation, login gates and existing circuit protections. Chrome UI checks cover the ownership-blocked New session flow, invalidation of the old chat, desktop/mobile layouts and simulated help/Continue states. The help feature has not been exercised against a deliberately stuck live Tinkercad build.

```sh
npm run check
npm test
npm run build
npm run test:browser
npm run test:layout # with the local backend running
```

Remove an old `/tmp/tinkercua-ui-session.json` from an earlier UI test before starting. Browser UI tests use a separate, freshly started backend to avoid claiming a real conversation’s ownership cookie:

```sh
PORT=4318 SESSION_FILE=/tmp/tinkercua-ui-session.json npm start
# In another terminal:
npm run test:ui
```

Additional checks:

```sh
node --import tsx scripts/session-smoke.ts
node --import tsx scripts/understanding-smoke.ts
npm run test:browser -- --model
```

`session-smoke` opens real Tinkercad in a temporary signed-out Chrome profile and checks the observation/action login gate. `understanding-smoke` and `--model` make billable API calls. `scripts/live-acceptance.ts` submits the real acceptance request through the chat, then submits the timing follow-up only after a completed report. It requires a fresh backend conversation and may require manual login. Inspect the actual report evidence; a terminal phase alone is not proof of LED behavior.

## Structure

- `public/`: responsive web chat, SSE updates, login and Stop controls, evidence reports.
- `src/server.ts`, `ownership.ts`: loopback HTTP service, owner cookie and request token, API/SSE transport.
- `src/controller.ts`: conversation state machine, cancellation, handoff and project association.
- `src/understanding.ts`: GPT-6 request scope and clarification step.
- `src/agent.ts`: Responses API computer-use loop, bounded execution, fresh screenshots, safety review and evidence reports.
- `src/browser.ts`: headed browser lifecycle, manual-login gate, project navigation boundary and Playwright executor.
- `recipes/arduino-led.md`: circuit recipe, loaded for each model turn. `src/guidance.ts`: application-defined progress/report function tools.
- `src/actions.ts`: strict action/coordinate/key validation and abortable batches.

The model remains `gpt-6-astra`. The existing documented `computer` tool, ordered `actions`, `computer_call_output`, original call IDs and `previous_response_id` are retained. `interpret_request`, `report_progress`, `request_help` and `finish_report` are application-defined function tools. Official references: [model](https://developers.openai.com/api/docs/models/gpt-6-astra), [computer use](https://developers.openai.com/api/docs/guides/tools-computer-use), [integration](https://developers.openai.com/api/docs/guides/tools-computer-use-integration).

Keys stay on the backend. `.env`, `.session.json`, profiles and `artifacts/` are excluded from Git and HTTP serving. Local run artifacts contain model responses, actions and post-login screenshots and may contain private project content; delete them when no longer needed. No login screenshots are intentionally collected.
