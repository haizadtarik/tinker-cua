import { chromium, type Browser, type BrowserContext, type Page, type Request } from 'playwright';
import { resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { Attention, mapKey, pause, projectId, type Action } from './actions.js';

export interface Observation { image: string; width: number; height: number; url: string; capturedAt: string; }
export interface Executor {
  observe(signal: AbortSignal): Promise<Observation>;
  execute(action: Action, signal: AbortSignal): Promise<void>;
}
export interface Session extends Executor {
  readonly isOpen: boolean;
  projectUrl?: string;
  open(signal: AbortSignal): Promise<void>;
  authenticated(signal: AbortSignal): Promise<boolean>;
  prepare(signal: AbortSignal, preserveCurrent?: boolean): Promise<void>;
  reset(): void;
  pauseForLogin(): void;
  pause(): void;
}
export function blocksNavigation(req: Pick<Request, 'isNavigationRequest' | 'frame' | 'url'>, selectedId?: string) {
  if (!selectedId || !req.isNavigationRequest()) return false;
  try { return !req.frame().parentFrame() && projectId(req.url()) !== selectedId; }
  catch { return true; }
}
export function dashboardProjectId(raw: string) {
  try { const url = new URL(raw); return ['www.tinkercad.com', 'tinkercad.com'].includes(url.hostname) ? url.pathname.match(/^\/things\/([a-zA-Z0-9]+)/)?.[1] : undefined; } catch { return undefined; }
}
const dashboard = 'https://www.tinkercad.com/dashboard/circuits';
export function isLoginUrl(raw: string) {
  try { const u = new URL(raw); return u.hostname !== 'www.tinkercad.com' && u.hostname !== 'tinkercad.com' || /\/(login|signin|join|auth)(\/|$)/i.test(u.pathname); }
  catch { return true; }
}
export class LoginRequired extends Attention {}
export class BrowserExecutor implements Session {
  context?: BrowserContext;
  page?: Page;
  projectUrl?: string;
  private connection?: Browser;
  private process?: ChildProcess;
  private endpoint?: string;
  private active = false;
  private creation = false;
  private priorProjects = new Set<string>();
  private boundaryIssue?: string;
  onClosed?: () => void;
  constructor(private channel = 'chrome', private profile = resolve('.browser-profile')) {}
  get isOpen() { return !!this.context && !!this.page && !this.page.isClosed(); }
  pause() { this.rememberProject(); this.active = false; }
  pauseForLogin() { this.active = false; this.boundaryIssue = undefined; }
  reset() { this.active = false; this.creation = false; this.projectUrl = undefined; this.priorProjects.clear(); this.boundaryIssue = undefined; }
  async open(signal: AbortSignal = new AbortController().signal) {
    signal.throwIfAborted();
    if (this.context) {
      if (!this.page || this.page.isClosed()) this.page = this.context.pages()[0] || await this.context.newPage();
      await this.page.setViewportSize({ width: 1280, height: 800 });
      if (this.page.url() === 'about:blank') await this.page.goto(dashboard, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await this.page.bringToFront(); signal.throwIfAborted(); return;
    }
    const profile = this.profile;
    if (this.channel === 'chrome') {
      // Start ordinary Chrome so the human can sign in, then attach automation.
      // No credentials, login automation, or anti-detection flags are used.
      let endpoint = this.endpoint;
      if (endpoint) {
        try { if (!(await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) })).ok) endpoint = undefined; }
        catch { endpoint = undefined; }
      }
      if (!endpoint) {
      const port = await new Promise<number>((resolvePort, reject) => {
        const server = createServer(); server.on('error', reject);
        server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolvePort((address as {port:number}).port)); });
      });
      const executable = process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : process.platform === 'win32' ? `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe` : 'google-chrome';
      let launchError: Error | undefined;
      this.process = spawn(executable, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', dashboard], { stdio: 'ignore' });
      this.process.on('error', e => { launchError = e; });
      endpoint = `http://127.0.0.1:${port}`;
      // Finish attaching even after Stop so the open browser remains managed.
      const launchSignal = AbortSignal.timeout(18000);
      let ready = false;
      for (let i = 0; i < 60; i++) {
        launchSignal.throwIfAborted();
        if (launchError) throw launchError;
        if (this.process.exitCode !== null) throw new Attention('Close the previous TinkerCUA browser window, then send your request again. Its dedicated profile is already open.');
        try { ready = (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.any([launchSignal, AbortSignal.timeout(500)]) })).ok; } catch { launchSignal.throwIfAborted(); }
        if (ready) break;
        await pause(250, launchSignal);
      }
      if (!ready) throw new Attention('Chrome did not become available. Close any previous TinkerCUA browser window and retry.');
      this.endpoint = endpoint;
      }
      this.connection = await chromium.connectOverCDP(endpoint);
      this.context = this.connection.contexts()[0];
    } else {
      this.context = await chromium.launchPersistentContext(profile, { headless: false, viewport: { width: 1280, height: 800 }, acceptDownloads: false });
    }
    const context = this.context!;
    context.on('close', () => { if (this.context === context) { this.context = undefined; this.page = undefined; this.active = false; this.onClosed?.(); } });
    const watch = (page: Page) => {
      page.on('framenavigated', frame => { if (frame === page.mainFrame() && page === this.page) this.rememberProject(); });
      page.on('close', () => { if (this.page === page) { this.active = false; this.onClosed?.(); } });
      page.on('dialog', async dialog => { this.boundaryIssue = 'A browser dialog needs your attention. Inspect the browser before continuing.'; await dialog.dismiss().catch(() => {}); });
    };
    context.pages().forEach(watch); context.on('page', watch);
    await context.route('**/*', async route => {
      const req = route.request();
      if (!this.active || !req.isNavigationRequest()) return route.continue();
      try { if (req.frame().parentFrame()) return route.continue(); } catch { return route.abort(); }
      if (isLoginUrl(req.url())) { this.pauseForLogin(); return route.continue(); }
      const id = projectId(req.url());
      if (this.projectUrl ? id === projectId(this.projectUrl) : this.creation && (id && !this.priorProjects.has(id) || new URL(req.url()).pathname.startsWith('/dashboard') || /^\/things\/(new|create)(\/|$)/.test(new URL(req.url()).pathname))) return route.continue();
      this.boundaryIssue = 'Navigation outside this conversation’s circuit was blocked. Inspect the browser before continuing.';
      return route.abort();
    });
    this.page = context.pages().find(p => p.url().includes('tinkercad.com')) || context.pages()[0] || await context.newPage();
    await this.page.setViewportSize({ width: 1280, height: 800 });
    if (this.page.url() === 'about:blank') await this.page.goto(dashboard, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await this.page.bringToFront(); signal.throwIfAborted();
  }
  async authenticated(signal: AbortSignal) {
    this.pauseForLogin(); signal.throwIfAborted();
    if (!this.isOpen) throw new Attention('The browser closed. Send your request again to reopen it.');
    // Read only known authentication/UI controls. Never capture login screenshots.
    const page = this.page!;
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    signal.throwIfAborted();
    if (isLoginUrl(page.url())) return false;
    if (await page.locator('input[type="password"]:visible, input[autocomplete="username"]:visible').count() > 0) return false;
    if (!page.url().includes('/dashboard')) {
      // Verify the account on the dashboard, even if an editor tab is publicly viewable.
      await page.goto(dashboard, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    if (!page.url().includes('/dashboard')) return false;
    try { await page.getByRole('button', { name: /create|new circuit/i }).first().waitFor({ state: 'visible', timeout: 5000 }); }
    catch { /* Some dashboard versions expose a link instead. */ }
    signal.throwIfAborted();
    return !isLoginUrl(page.url()) && (await page.getByRole('button', { name: /create|new circuit/i }).first().isVisible() || await page.getByRole('link', { name: /create|new circuit/i }).first().isVisible());
  }
  async prepare(signal: AbortSignal, preserveCurrent = false) {
    signal.throwIfAborted();
    if (!this.isOpen) throw new Attention('The browser closed. Send your instruction again to reopen it.');
    this.boundaryIssue = undefined;
    const page = this.page!;
    if (preserveCurrent && this.projectUrl && projectId(page.url()) === projectId(this.projectUrl)) {
      this.active = true; await this.checkLogin(page, signal); await page.bringToFront(); return;
    }
    if (this.projectUrl) await page.goto(this.projectUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    else {
      if (!page.url().includes('/dashboard')) await page.goto(dashboard, { waitUntil: 'domcontentloaded', timeout: 45000 });
      this.priorProjects = new Set((await page.locator('a[href*="/things/"]').evaluateAll(elements => elements.map(e => (e as HTMLAnchorElement).href))).map(dashboardProjectId).filter((id): id is string => !!id));
      this.creation = true;
    }
    signal.throwIfAborted();
    if (isLoginUrl(page.url())) throw new LoginRequired('Your Tinkercad session needs login.');
    this.active = true;
    await page.bringToFront();
  }
  private rememberProject() {
    if (!this.page || this.projectUrl || !this.creation) return;
    const id = projectId(this.page.url());
    if (id && !this.priorProjects.has(id)) { this.projectUrl = this.page.url(); this.creation = false; }
  }
  private guard(signal: AbortSignal): Page {
    signal.throwIfAborted();
    if (!this.isOpen) throw new Attention('The browser closed. Send your instruction again to reopen it.');
    if (!this.active || isLoginUrl(this.page!.url())) throw new LoginRequired('Browser observation is paused. Complete login using the chat button.');
    if (this.boundaryIssue) throw new Attention(this.boundaryIssue);
    const id = projectId(this.page!.url());
    if (!this.projectUrl && this.creation && id) {
      if (this.priorProjects.has(id)) throw new Attention('An existing circuit was opened. A new empty project is required; inspect the browser.');
      this.projectUrl = this.page!.url(); this.creation = false;
    }
    if (this.projectUrl && id !== projectId(this.projectUrl)) throw new Attention('The browser left this conversation’s circuit. Send your instruction again to reopen it.');
    return this.page!;
  }
  private async checkLogin(page: Page, signal: AbortSignal) {
    if (await page.locator('input[type="password"]:visible, input[autocomplete="username"]:visible').count() > 0) { this.pauseForLogin(); throw new LoginRequired('Login is required.'); }
    this.guard(signal);
  }
  async observe(signal: AbortSignal): Promise<Observation> {
    const page = this.guard(signal);
    await this.checkLogin(page, signal);
    const buffer = await page.screenshot({ type: 'png', scale: 'css', timeout: 15000 });
    await this.checkLogin(page, signal);
    const size = page.viewportSize(); if (!size) throw new Attention('Browser viewport is unavailable.');
    return { image: buffer.toString('base64'), ...size, url: page.url(), capturedAt: new Date().toISOString() };
  }
  async execute(action: Action, signal: AbortSignal) {
    const page = this.guard(signal);
    await this.checkLogin(page, signal);
    await executeOnPage(page, action, signal, () => { this.guard(signal); });
  }
  async close() { this.pause(); try { await this.context?.close(); } finally { this.process?.kill(); this.endpoint = undefined; } }
}

export async function executeOnPage(page: Page, action: Action, signal: AbortSignal, guard = () => {}) {
  const check = () => { signal.throwIfAborted(); guard(); };
  check();
  const held: string[] = [];
  try {
    if ('keys' in action && action.keys && action.type !== 'keypress') {
      for (const key of action.keys.map(mapKey)) { check(); await page.keyboard.down(key); held.push(key); }
    }
    check();
    switch (action.type) {
      case 'click': await page.mouse.click(action.x, action.y, { button: action.button === 'wheel' ? 'middle' : action.button }); break;
      case 'double_click': await page.mouse.dblclick(action.x, action.y); break;
      case 'move': await page.mouse.move(action.x, action.y); break;
      case 'scroll': await page.mouse.move(action.x, action.y); check(); await page.mouse.wheel(action.scroll_x, action.scroll_y); break;
      case 'type': await page.keyboard.insertText(action.text); break;
      case 'keypress':
        for (const key of action.keys.map(mapKey)) { check(); await page.keyboard.down(key); held.push(key); }
        break;
      case 'drag': {
        await page.mouse.move(action.path[0].x, action.path[0].y); check();
        await page.mouse.down();
        try {
          for (const point of action.path.slice(1)) { check(); await page.mouse.move(point.x, point.y); await pause(35, signal); }
        } finally { await page.mouse.up(); }
        break;
      }
      case 'wait': await pause(700, signal); break;
      case 'screenshot': break;
    }
  } finally {
    for (const key of held.reverse()) await page.keyboard.up(key).catch(() => {});
  }
  check();
}
