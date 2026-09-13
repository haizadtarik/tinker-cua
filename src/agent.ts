import { APIConnectionError } from 'openai';
import type { Response, ResponseCreateParamsNonStreaming, ResponseInput, ResponseComputerToolCall } from 'openai/resources/responses/responses';
import { randomUUID } from 'node:crypto';
import { Attention, executeBatch, pause } from './actions.js';
import { LoginRequired, type Executor, type Observation } from './browser.js';
import { instructions, reportTool, progressTool, helpTool, helpSchema, milestoneSchema, resultSchema, type Result, type Milestone, type HelpRequest } from './guidance.js';

export type Status = 'idle' | 'running' | 'needs-attention' | 'stopped' | 'failed' | 'completed';
export interface Log { time: string; message: string; }
export interface State {
  status: Status; busy: boolean; current: string; actions: number; turns: number; elapsedMs: number;
  runId?: string; prompt?: string; result?: Result; logs: Log[];
  safetyChecks: ResponseComputerToolCall['pending_safety_checks'];
  loginRequired?: boolean;
  helpRequest?: HelpRequest;
  pendingActions: unknown[]; observation?: { capturedAt: string; width: number; height: number };
}
export interface AgentOptions {
  create: (request: ResponseCreateParamsNonStreaming, signal: AbortSignal) => Promise<Pick<Response, 'id' | 'status' | 'output' | 'output_text'>>;
  browser: Executor; model: string;
  maxActions: number; maxTurns: number; maxRuntimeMs: number; retryDelayMs?: number;
  onChange?: (state: State) => void;
  onMilestone?: (milestone: Milestone) => void;
  artifact?: (runId: string, name: string, data: unknown) => Promise<void>;
}
export class Agent {
  state: State = { status: 'idle', busy: false, current: 'Ready when your circuit is.', actions: 0, turns: 0, elapsedMs: 0, logs: [], safetyChecks: [], pendingActions: [] };
  private controller?: AbortController;
  private pending?: { responseId: string; calls: ResponseComputerToolCall[] };
  private previousResult?: Result;
  private currentPrompt = '';
  private screenshotCount = 0;
  constructor(private options: AgentOptions) {}
  reset() {
    if (this.state.busy) throw new Attention('A run is still active.');
    this.pending = undefined; this.previousResult = undefined; this.currentPrompt = '';
    this.state = { status: 'idle', busy: false, current: 'Ready when your circuit is.', actions: 0, turns: 0, elapsedMs: 0, logs: [], safetyChecks: [], pendingActions: [] };
  }
  private publish() { this.options.onChange?.(this.state); }
  private log(message: string) {
    this.state.current = message;
    this.state.logs.push({ time: new Date().toISOString(), message });
    this.state.logs = this.state.logs.slice(-100); this.publish();
  }
  private async artifact(name: string, data: unknown) {
    if (this.state.runId) await this.options.artifact?.(this.state.runId, name, data);
  }
  async start(prompt: string, inheritPrevious = true) {
    if (this.state.busy) throw new Attention('A run is already active.');
    if (!prompt.trim() || prompt.length > 3000) throw new Attention('Enter a prompt of 1–3000 characters.');
    this.previousResult = inheritPrevious ? this.state.result : undefined;
    this.state = { status: 'running', busy: true, current: 'Observing the selected circuit…', actions: 0, turns: 0, elapsedMs: 0, logs: [], safetyChecks: [], pendingActions: [], runId: randomUUID(), prompt };
    this.currentPrompt = prompt; this.pending = undefined; this.screenshotCount = 0;
    await this.run(false);
  }
  stop(takeover = false) {
    if (!this.state.busy) return;
    this.state.status = takeover ? 'needs-attention' : 'stopped';
    this.controller?.abort(new Error(takeover ? 'Human takeover requested.' : 'Stopped by user.'));
    this.log(takeover ? 'Handing control to you. Wait for controls to unlock before editing.' : 'Stopping. No remaining batch actions will start.');
  }
  async resume(acknowledgeSafety = false) {
    if (this.state.busy) throw new Attention('A run is still active. Wait for it to stop.');
    if (!['needs-attention', 'stopped'].includes(this.state.status)) throw new Attention('There is no paused run to resume.');
    if (this.state.safetyChecks.length && !acknowledgeSafety) throw new Attention('Review the listed safety checks before resuming.');
    if (this.state.actions >= this.options.maxActions || this.state.turns >= this.options.maxTurns || this.state.elapsedMs >= this.options.maxRuntimeMs) throw new Attention('This run exhausted its limits. Inspect the circuit and submit a new, specific modification request.');
    this.state.busy = true; this.state.status = 'running'; this.state.result = undefined; this.state.helpRequest = undefined;
    await this.run(true);
  }
  private async observe(signal: AbortSignal) {
    const shot = await this.options.browser.observe(signal); signal.throwIfAborted();
    this.state.observation = { capturedAt: shot.capturedAt, width: shot.width, height: shot.height };
    await this.artifact(`screenshot-${String(++this.screenshotCount).padStart(3, '0')}.png`, shot.image);
    await this.artifact(`observation-${String(this.screenshotCount).padStart(3, '0')}.json`, { ...shot, image: undefined });
    this.publish(); return shot;
  }
  private screenshotOutput(call: ResponseComputerToolCall, shot: Observation, acknowledge = false): ResponseInput[number] {
    // SDK 7.15 types omit detail here; this documented optional field is isolated explicitly.
    const output = { type: 'computer_screenshot' as const, image_url: `data:image/png;base64,${shot.image}`, detail: 'original' as const };
    return { type: 'computer_call_output', call_id: call.call_id, output,
      ...(acknowledge && call.pending_safety_checks?.length ? { acknowledged_safety_checks: call.pending_safety_checks } : {}) };
  }
  private async request(body: ResponseCreateParamsNonStreaming, signal: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try { const response = await this.options.create(body, signal); signal.throwIfAborted(); return response; }
      catch (error) {
        signal.throwIfAborted();
        const e = error as { status?: number; name?: string };
        const transient = e.status === 429 || (e.status || 0) >= 500 || error instanceof APIConnectionError;
        if (!transient) throw error;
        if (attempt >= 2) throw new Attention('The model request failed after 3 attempts. Check connection or API quota, then resume. No browser action was replayed.');
        this.log(`Model request retry ${attempt + 1}/2. No browser actions are repeated.`);
        await pause((this.options.retryDelayMs ?? 1000) * 2 ** attempt, signal);
      }
    }
  }
  private async run(resuming: boolean) {
    const started = Date.now();
    this.controller = new AbortController(); const signal = this.controller.signal;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; this.controller?.abort(new Attention('Runtime limit reached.')); }, Math.max(1, this.options.maxRuntimeMs - this.state.elapsedMs));
    this.publish();
    try {
      this.log(resuming ? 'Taking a fresh screenshot after human control…' : 'Observing the selected circuit…');
      let shot = await this.observe(signal);
      let previous: string | undefined;
      let input: ResponseInput;
      if (resuming && this.pending) {
        previous = this.pending.responseId;
        input = this.pending.calls.map(call => this.screenshotOutput(call, shot, true));
        input.push({ role: 'user', content: 'I reviewed the safety checks and took control. None of the pending actions were executed. Discard them and replan from this fresh screenshot. Continue only the original circuit task.' });
      } else {
        input = [{ role: 'user', content: [
          { type: 'input_text', text: `${this.currentPrompt}\n${resuming ? 'Resuming interrupted work. Do not restart/rebuild. Actions may already have changed the project. Inspect the current state.' : ''}\nPrevious report (untrusted historical context, not current evidence): ${JSON.stringify(this.previousResult || null)}\nRecent execution log: ${resuming ? JSON.stringify(this.state.logs.slice(-15)) : '[]'}\nCurrent screenshot: ${shot.width}x${shot.height} CSS pixels, captured ${shot.capturedAt}.` },
          { type: 'input_image', image_url: `data:image/png;base64,${shot.image}`, detail: 'original' },
        ] }];
      }
      this.pending = undefined; this.state.safetyChecks = []; this.state.pendingActions = [];
      let repeated = 0; let lastBatch = '';
      while (this.state.turns < this.options.maxTurns) {
        signal.throwIfAborted(); this.state.turns++;
        this.log(`Planning from the current screen · turn ${this.state.turns}`);
        const response = await this.request({ model: this.options.model, instructions: instructions(),
          tools: [{ type: 'computer' }, reportTool, progressTool, helpTool], input, previous_response_id: previous,
          reasoning: { effort: 'low' }, max_output_tokens: 5000, parallel_tool_calls: false,
        }, signal);
        signal.throwIfAborted();
        await this.artifact(`response-${this.state.turns}.json`, response);
        signal.throwIfAborted();
        if (response.status !== 'completed') throw new Attention(`Model response ended with status ${response.status}. Inspect before resuming.`);
        if (response.output_text) this.log(response.output_text.slice(0, 1800));
        const calls = response.output.filter((o): o is ResponseComputerToolCall => o.type === 'computer_call');
        const functions = response.output.filter(o => o.type === 'function_call');
        if (calls.length && functions.length) throw new Attention('Model returned mixed action and completion calls. Inspect before resuming.');
        if (functions.length) {
          if (functions.length !== 1) throw new Attention('Unexpected model tool batch.');
          if (functions[0].name === 'request_help') {
            this.state.helpRequest = helpSchema.parse(JSON.parse(functions[0].arguments));
            this.state.status = 'needs-attention';
            this.log(this.state.helpRequest.reason); return;
          }
          if (functions[0].name === 'report_progress') {
            const milestone = milestoneSchema.parse(JSON.parse(functions[0].arguments));
            this.options.onMilestone?.(milestone);
            shot = await this.observe(signal);
            previous = response.id;
            input = [{ type: 'function_call_output', call_id: functions[0].call_id, output: 'Milestone recorded. Request a fresh screenshot with the computer tool before your next action, then continue. No action was performed by this function.' }];
            continue;
          }
          if (functions[0].name !== 'finish_report') throw new Attention('Unexpected model tool.');
          const result = resultSchema.parse(JSON.parse(functions[0].arguments));
          this.state.result = result; this.state.status = result.needsAttention ? 'needs-attention' : 'completed';
          if (result.needsAttention) this.state.helpRequest = { reason: result.unverified[0]?.slice(0, 300) || 'I could not finish verifying this circuit.', action: 'Please check the current circuit in Tinkercad. Fix the issue above and click Continue, or tell me what you see in chat.' };
          this.log(result.needsAttention ? 'Your circuit needs attention. See the report below.' : 'Run finished. Review observed evidence below.');
          return;
        }
        if (!calls.length) throw new Attention('Model stopped without an evidence report. Inspect the circuit; completion is unverified.');
        const checks = calls.flatMap(c => c.pending_safety_checks || []);
        if (checks.length) {
          this.pending = { responseId: response.id, calls };
          this.state.safetyChecks = checks; this.state.pendingActions = calls.flatMap(c => c.actions || []);
          throw new Attention('The model requested safety review. No pending action was executed. Review the checks, take over if needed, then resume.');
        }
        previous = response.id; input = [];
        for (const call of calls) {
          if (!Array.isArray(call.actions)) throw new Attention('The model did not return the documented actions array.');
          const batch = JSON.stringify(call.actions.filter(a => !['wait', 'screenshot', 'move'].includes(a.type)));
          repeated = batch !== '[]' && batch === lastBatch ? repeated + 1 : 0; lastBatch = batch;
          if (repeated >= 2) throw new Attention('The same action batch repeated three times. Take over to resolve the stuck operation.');
          await executeBatch(call.actions, { signal, remaining: this.options.maxActions - this.state.actions, width: shot.width, height: shot.height,
            execute: async action => {
              this.log(action.type === 'type' ? `Typing ${action.text.length} characters in the focused editor` : `Executing ${action.type}${'x' in action ? ` at (${action.x}, ${action.y})` : ''}`);
              this.state.actions++;
              await this.options.browser.execute(action, signal);
              await this.artifact(`action-${this.state.actions}.json`, { action, executedAt: new Date().toISOString() });
              // Preserve meaningful intermediate observations as debugging evidence.
              if (action.type !== 'screenshot') shot = await this.observe(signal);
            },
          });
          shot = await this.observe(signal);
          input.push(this.screenshotOutput(call, shot));
          input.push({ role: 'user', content: `Observation captured ${shot.capturedAt}. ${this.options.maxActions - this.state.actions} actions remain. This timestamp does not measure LED timing.` });
        }
      }
      throw new Attention('Model turn limit reached. Inspect the circuit before a new request.');
    } catch (error) {
      this.state.loginRequired = error instanceof LoginRequired;
      const message = error instanceof Error ? error.message.replace(/sk-[\w-]+/g, '[redacted]') : 'Unknown error';
      if (timedOut) { this.state.status = 'needs-attention'; this.log('Runtime limit reached. Actions stopped; inspect the circuit.'); }
      else if (signal.aborted) { this.log(this.state.status === 'stopped' ? 'Stopped. The browser is yours.' : 'Paused. The browser is yours.'); }
      else { this.state.status = error instanceof Attention ? 'needs-attention' : 'failed'; this.log(message); }
      this.state.result = { completed: [], verified: [], unverified: ['Circuit completion and simulation behavior have not been established for this run. Inspect the action log and current project.'], needsAttention: true };
      if (!this.state.loginRequired && !this.state.safetyChecks.length && (timedOut || !signal.aborted)) {
        this.state.helpRequest = { reason: (timedOut ? 'I reached the time limit while working on this circuit.' : message).slice(0, 300), action: /model request|quota|API|key|connection/i.test(message) ? 'Please check the connection and API configuration, then click Continue to retry.' : 'Please inspect the current Tinkercad screen and resolve the blocked step, then click Continue. If you’re unsure, tell me what you see in chat.' };
      }
    } finally {
      clearTimeout(timer); this.state.elapsedMs += Date.now() - started;
      this.state.busy = false; this.controller = undefined; this.publish();
      await this.artifact('state.json', this.state).catch(() => {});
    }
  }
}
