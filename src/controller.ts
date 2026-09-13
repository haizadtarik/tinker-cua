import { randomUUID } from 'node:crypto';
import { Attention } from './actions.js';
import { LoginRequired, type Session } from './browser.js';
import { Agent, type State as AgentState } from './agent.js';
import type { Interpretation } from './understanding.js';
import type { Result, Milestone, HelpRequest } from './guidance.js';
export type Phase = 'idle' | 'understanding_request' | 'launching_browser' | 'awaiting_login' | 'creating_project' | 'building' | 'simulating' | 'completed' | 'needs_input' | 'stopped' | 'failed';
export interface Message { id: string; role: 'assistant' | 'user'; text: string; kind?: 'progress' | 'report'; result?: Result; projectUrl?: string; }
export interface ConversationState { revision: number; id: string; phase: Phase; busy: boolean; browserOpen: boolean; projectUrl?: string; messages: Message[]; safetyChecks: AgentState['safetyChecks']; helpRequest?: HelpRequest; }
interface Options { browser: Session; agent: Agent; understand: (prompt: string, history: string, signal: AbortSignal) => Promise<Interpretation>; onChange: (state: ConversationState) => void; }
const loginMessage = 'Please log in to Tinkercad in the browser window I opened. Click ‘I’m logged in’ when you’re ready.';
export class Controller {
  state: ConversationState = { revision: 0, id: randomUUID(), phase: 'idle', busy: false, browserOpen: false, messages: [{ id: randomUUID(), role: 'assistant', text: 'What circuit would you like to build?' }], safetyChecks: [] };
  private operation?: AbortController;
  private pendingTask?: string;
  private requestIds = new Set<string>();
  private closedDuringRun = false;
  private seenMilestones = new Set<string>();
  constructor(private options: Options) {}
  assertCanReset() { if (this.state.busy || this.options.agent.state.busy) throw new Attention('A request is active. Stop it in its chat and wait before starting a new session.'); }
  newSession() {
    this.assertCanReset(); this.options.browser.reset(); this.options.agent.reset();
    this.pendingTask = undefined; this.requestIds.clear(); this.seenMilestones.clear(); this.closedDuringRun = false;
    this.state = { revision: 0, id: randomUUID(), phase: 'idle', busy: false, browserOpen: this.options.browser.isOpen, messages: [{ id: randomUUID(), role: 'assistant', text: 'What circuit would you like to build?' }], safetyChecks: [] };
    this.publish();
  }
  snapshot() { return { state: this.state, pendingTask: this.pendingTask, requestIds: [...this.requestIds] }; }
  restore(snapshot: ReturnType<Controller['snapshot']>) {
    this.state = { ...snapshot.state, revision: (snapshot.state.revision || 0) + 1, busy: false, browserOpen: false, safetyChecks: [] };
    this.options.browser.projectUrl = snapshot.state.projectUrl;
    this.pendingTask = snapshot.pendingTask; this.requestIds = new Set(snapshot.requestIds || []);
    if (snapshot.state.busy || snapshot.state.safetyChecks.length || snapshot.state.phase === 'awaiting_login') {
      this.state.phase = 'stopped';
      this.state.messages.push({ id: randomUUID(), role: 'assistant', text: 'The local backend restarted. Actions are stopped. Send your next instruction to inspect the saved project and continue.' });
    }
  }
  private publish() { this.state.revision++; this.state.browserOpen = this.options.browser.isOpen; this.state.projectUrl = this.options.browser.projectUrl; this.options.onChange(this.state); }
  private say(text: string, extra: Partial<Message> = {}) { this.state.messages.push({ id: randomUUID(), role: 'assistant', text, ...extra }); this.publish(); }
  private phase(phase: Phase) { this.state.phase = phase; this.publish(); }
  private claim() { if (this.state.busy || this.options.agent.state.busy) throw new Attention('A request is active. Stop it and wait before sending the next instruction.'); this.operation = new AbortController(); this.closedDuringRun = false; this.state.busy = true; return this.operation.signal; }
  private finish() { this.options.browser.pause(); this.state.busy = false; this.operation = undefined; this.publish(); }
  private handoff() { this.options.browser.pauseForLogin(); this.phase('awaiting_login'); this.say(loginMessage); }
  private failure(error: unknown, signal: AbortSignal) {
    if (signal.aborted) { this.phase(this.closedDuringRun ? 'needs_input' : 'stopped'); return; }
    if (error instanceof LoginRequired) { this.handoff(); return; }
    this.phase(error instanceof Attention ? 'needs_input' : 'failed');
    const message = error instanceof Error ? error.message.replace(/sk-[\w-]+/g, '[redacted]') : 'Something went wrong. Send your instruction again to retry.';
    if (this.pendingTask && !this.state.safetyChecks.length) {
      this.state.helpRequest = { reason: message.slice(0, 300), action: 'Please check that the Tinkercad window is ready, then click Continue to retry. You can also tell me what you see in chat.' };
      this.say(`I need your help. ${this.state.helpRequest.reason}\n${this.state.helpRequest.action}`);
    } else this.say(message);
  }
  async message(prompt: string, requestId: string) {
    if (this.requestIds.has(requestId)) return;
    if (this.state.phase === 'awaiting_login') throw new Attention('Finish login and click “I’m logged in”, or Stop before changing your request.');
    const signal = this.claim(); this.requestIds.add(requestId); this.state.helpRequest = undefined;
    this.state.messages.push({ id: randomUUID(), role: 'user', text: prompt }); this.phase('understanding_request');
    try {
      const history = JSON.stringify(this.state.messages.slice(-16).map(m => ({ role: m.role, text: m.text })));
      const understood = await this.options.understand(prompt, history, signal); signal.throwIfAborted();
      this.say(understood.message);
      if (understood.decision !== 'supported') { this.phase('needs_input'); return; }
      this.pendingTask = understood.task; this.seenMilestones.clear();
      this.phase('launching_browser'); await this.options.browser.open(signal); signal.throwIfAborted();
      if (!await this.options.browser.authenticated(signal)) { signal.throwIfAborted(); this.handoff(); return; }
      await this.build(signal);
    } catch (error) { this.failure(error, signal); }
    finally { this.finish(); }
  }
  async loginCheck() {
    if (this.state.phase !== 'awaiting_login' || !this.pendingTask) throw new Attention('There is no login handoff waiting.');
    const signal = this.claim(); this.publish();
    try {
      const authenticated = await this.options.browser.authenticated(signal); signal.throwIfAborted();
      if (!authenticated) { this.say('Login is not complete yet. Finish signing in until your Tinkercad dashboard appears, then click “I’m logged in” again.'); return; }
      this.say('You’re signed in. I’m continuing with your circuit.'); await this.build(signal);
    } catch (error) { this.failure(error, signal); }
    finally { this.finish(); }
  }
  private async build(signal: AbortSignal) {
    const existing = !!this.options.browser.projectUrl;
    await this.options.browser.prepare(signal); signal.throwIfAborted();
    this.phase(existing ? 'building' : 'creating_project');
    this.say(existing ? 'I’m inspecting your current circuit before making changes.' : 'I’m opening a new empty Circuits project.', { kind: 'progress' });
    const task = `${existing ? 'FOLLOW-UP: Reuse this exact project. Inspect current components, wiring and code; change only what is needed. Do not duplicate components or create another project.' : 'FIRST BUILD: Starting on the authenticated dashboard, create a NEW EMPTY Circuits project using the visible Create controls. Never choose an existing project, starter or template. Confirm the canvas is empty before adding components.'}\nUser task: ${this.pendingTask}`;
    await this.options.agent.start(task, existing); signal.throwIfAborted(); this.acceptResult();
  }
  agentChanged(state: AgentState) { this.state.safetyChecks = state.safetyChecks; this.publish(); }
  milestone(m: Milestone) {
    if (!this.state.busy || this.operation?.signal.aborted) return;
    if (m.phase !== 'creating_project' && !this.options.browser.projectUrl) throw new Attention('The new circuit has not been opened. Construction cannot be reported as started.');
    this.phase(m.phase);
    if (!this.seenMilestones.has(m.message)) { this.seenMilestones.add(m.message); this.say(m.message, { kind: 'progress' }); }
  }
  private acceptResult() {
    const state = this.options.agent.state;
    if (state.status === 'stopped') { this.phase('stopped'); return; }
    if (!this.options.browser.isOpen) { this.phase('needs_input'); this.say('The browser closed. Send your instruction again to reopen it; your project link is preserved.'); return; }
    // The browser gate is authoritative if authentication expires during CUA.
    if (state.loginRequired) { this.handoff(); return; }
    const result = state.result;
    if (result && !this.options.browser.projectUrl) { result.needsAttention = true; result.unverified.push('Creating a new empty Circuit project and building from scratch are incomplete.'); }
    if (state.helpRequest) {
      this.state.helpRequest = state.helpRequest; this.phase('needs_input');
      this.say(`I need your help. ${state.helpRequest.reason}\n${state.helpRequest.action}`, result ? { kind: 'report', result, projectUrl: this.options.browser.projectUrl } : {}); return;
    }
    this.phase(state.status === 'completed' && result && !result.needsAttention ? 'completed' : state.status === 'failed' ? 'failed' : 'needs_input');
    if (result) this.say(this.state.phase === 'completed' ? 'Here’s what I changed and what I could verify.' : `The build needs attention. ${state.current}`, { kind: 'report', result, projectUrl: this.options.browser.projectUrl });
  }
  stop() {
    this.state.helpRequest = undefined;
    this.operation?.abort(new Error('Stopped by user.')); this.options.agent.stop(); this.options.browser.pause();
    this.phase('stopped'); this.say('Stopped. The browser stays open for inspection. Wait for the current request to finish, then send the next instruction.');
  }
  browserClosed() { this.closedDuringRun = true; this.options.agent.stop(); this.operation?.abort(new Error('Browser closed.')); this.phase('needs_input'); this.say('The Tinkercad browser closed. Send your instruction again to reopen it and continue with the saved project.'); }
  async resumeHelp() {
    if (!this.state.helpRequest || !this.pendingTask || this.state.safetyChecks.length) throw new Attention('There is no help request waiting.');
    const signal = this.claim(); const help = this.state.helpRequest; this.state.helpRequest = undefined; this.publish();
    try {
      const wasOpen = this.options.browser.isOpen;
      await this.options.browser.open(signal); signal.throwIfAborted();
      if ((!wasOpen || !this.options.browser.projectUrl) && !await this.options.browser.authenticated(signal)) { this.handoff(); return; }
      await this.options.browser.prepare(signal, true); signal.throwIfAborted(); this.phase('building');
      this.say('Thanks. I’ll inspect your current screen and continue from there.', { kind: 'progress' });
      await this.options.agent.start(`${this.options.browser.projectUrl ? 'Continue the original task' : 'FIRST BUILD: create a new empty Circuits project; never open existing tiles. Original task'}: ${this.pendingTask.slice(0, 2200)}\nThe user has helped with this blocker: ${help.reason}. Inspect the fresh screenshot before acting. Keep the current project and existing work; do not duplicate components. If still blocked, request_help with one specific next step.`, !!this.options.browser.projectUrl);
      signal.throwIfAborted(); this.acceptResult();
    } catch (error) { this.failure(error, signal); } finally { this.finish(); }
  }
  async resumeSafety(acknowledge: boolean) {
    if (!this.options.agent.state.safetyChecks.length || !acknowledge) throw new Attention('Review and acknowledge the safety checks first.');
    const signal = this.claim();
    try {
      if (!await this.options.browser.authenticated(signal)) { this.handoff(); return; }
      await this.options.browser.prepare(signal); signal.throwIfAborted(); this.phase('building');
      await this.options.agent.resume(true); signal.throwIfAborted(); this.acceptResult();
    } catch (error) { this.failure(error, signal); } finally { this.finish(); }
  }
}
