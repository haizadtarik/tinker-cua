const $ = id => document.getElementById(id);
let token; let latest; let pendingMessage; let sending = false; let connected = false; let safetyKey = ''; let rendered = '';
let resetToken; let events; let generation = 0;
const phases = { idle: 'Ready to build', understanding_request: 'Understanding your idea', launching_browser: 'Opening Tinkercad', awaiting_login: 'Waiting for your login', creating_project: 'Creating your project', building: 'Building your circuit', simulating: 'Checking simulation', completed: 'Ready for your next idea', needs_input: 'Your attention needed', stopped: 'Stopped', failed: 'Request interrupted' };
function node(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text) el.textContent = text; return el; }
function projectLink(url, label) {
  try { const u = new URL(url); if (u.protocol !== 'https:' || !['www.tinkercad.com', 'tinkercad.com'].includes(u.hostname) || !/^\/things\/[a-zA-Z0-9]+(?:-[^/]*)?\/editel\/?$/.test(u.pathname)) return null; const a = node('a', 'report-link', label); a.href = u.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; } catch { return null; }
}
function render(state) {
  if (latest && state.id === latest.id && state.revision < latest.revision) return;
  latest = state;
  $('phase').textContent = phases[state.phase] || state.phase;
  $('browser-status').textContent = state.browserOpen ? state.phase === 'awaiting_login' ? 'Open · waiting for you to sign in' : 'Connected to your dedicated session' : state.projectUrl ? 'Closed · your project link is saved' : 'Opens when your build is ready.';
  $('browser-dot').classList.toggle('online', state.browserOpen);
  $('project-link').hidden = !state.projectUrl;
  const valid = state.projectUrl && projectLink(state.projectUrl, ''); if (valid) $('project-link').href = valid.href;
  const signature = JSON.stringify(state.messages);
  if (signature !== rendered) {
    const log = $('conversation'); const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 100;
    log.replaceChildren();
    for (const message of state.messages) {
      const row = node('article', `message ${message.role} ${message.kind || ''}`);
      row.append(node('div', 'avatar', message.role === 'user' ? 'YOU' : 't↗'));
      const content = node('div', 'message-content'); content.append(node('p', '', message.text));
      if (message.result) {
        for (const [key, label] of [['completed', 'Work performed'], ['verified', 'Observed evidence'], ['unverified', 'Still unverified']]) {
          if (!message.result[key]?.length) continue;
          const group = node('div', `report-group ${key}`); group.append(node('strong', '', label));
          const ul = node('ul'); message.result[key].forEach(text => ul.append(node('li', '', text))); group.append(ul); content.append(group);
        }
        const link = projectLink(message.projectUrl, 'Open this circuit in Tinkercad ↗'); if (link) content.append(link);
      }
      row.append(content); log.append(row);
    }
    rendered = signature; if (atBottom) log.scrollTop = log.scrollHeight;
  }
  $('examples').hidden = state.messages.some(m => m.role === 'user');
  $('handoff').hidden = state.phase !== 'awaiting_login';
  $('login').disabled = state.busy || sending || !connected;
  $('new-session').disabled = sending || state.busy;
  $('new-session').title = state.busy ? 'Stop the current request and wait before starting a new session.' : 'Start a fresh chat. Your Tinkercad login and circuits are kept.';
  $('help').hidden = !state.helpRequest || state.busy || state.phase === 'awaiting_login';
  $('help-reason').textContent = state.helpRequest?.reason || '';
  $('help-action').textContent = state.helpRequest?.action || '';
  $('continue').disabled = state.busy || sending || !connected;
  $('activity').hidden = !state.busy && state.phase !== 'awaiting_login';
  $('activity-text').textContent = state.busy ? phases[state.phase] : 'Observation and actions paused';
  $('stop').disabled = sending || state.phase === 'stopped';
  const checks = state.safetyChecks || [];
  const newSafetyKey = JSON.stringify(checks); if (newSafetyKey !== safetyKey) { $('acknowledge').checked = false; safetyKey = newSafetyKey; }
  $('safety').hidden = !checks.length || state.busy || state.phase === 'awaiting_login';
  $('safety-list').replaceChildren(...checks.map(c => node('li', '', c.message || c.code || 'Review requested action')));
  $('resume').disabled = !$('acknowledge').checked || state.busy || sending || !connected;
  const blocked = state.busy || state.phase === 'awaiting_login' || sending || !connected;
  $('prompt').disabled = blocked; $('send').disabled = blocked;
  $('composer-hint').textContent = !connected ? 'Reconnecting to your local backend…' : state.phase === 'awaiting_login' ? 'Finish login above, or Stop to change your request.' : state.busy ? 'Watch the browser. Stop and wait before sending another instruction.' : 'Enter to send · Shift + Enter for a new line';
  if (!state.keyConfigured) showError('Add OPENAI_API_KEY to .env and restart the local backend to build.');
}
function showError(message) { $('error').textContent = message; $('error').hidden = !message; }
async function command(path, data = {}) {
  if (sending || !connected) return;
  const current = generation;
  sending = true; showError(''); if (latest) render(latest);
  try {
    const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tinkercua-token': token }, body: JSON.stringify(data) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Request failed.');
    if (current !== generation) return false;
    render(value); return true;
  } catch (error) { showError(error.message); return false; }
  finally { sending = false; if (latest) render(latest); }
}
$('composer').addEventListener('submit', async event => { event.preventDefault(); const prompt = $('prompt').value.trim(); if (!prompt || latest?.busy) return; if (!pendingMessage || pendingMessage.prompt !== prompt) pendingMessage = { prompt, requestId: crypto.randomUUID() }; if (await command('message', pendingMessage)) { $('prompt').value = ''; pendingMessage = undefined; } });
$('prompt').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); } });
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => { if ($('prompt').disabled) return; $('prompt').value = button.dataset.prompt; $('prompt').focus(); }));
$('login').addEventListener('click', () => command('login-check'));
$('stop').addEventListener('click', () => command('stop'));
$('acknowledge').addEventListener('change', () => render(latest));
$('resume').addEventListener('click', () => command('resume', { acknowledgeSafety: $('acknowledge').checked }));
$('continue').addEventListener('click', () => command('continue'));
function disconnected(message) {
  connected = false; token = undefined;
  if (latest) render(latest);
  $('phase').textContent = 'Session unavailable'; $('prompt').disabled = true; $('send').disabled = true;
  showError(message);
}
async function connect() {
  const current = ++generation; events?.close();
  try {
    const response = await fetch('/api/session'); const session = await response.json();
    if (current !== generation) return;
    resetToken = session.resetToken;
    if (!response.ok) throw new Error(session.error);
    token = session.token; connected = true; showError(''); render(session.state);
    events = new EventSource('/api/events');
    events.onmessage = event => { if (current !== generation) return; connected = true; render(JSON.parse(event.data)); };
    events.addEventListener('session-ended', () => {
      if (current !== generation) return;
      events.close(); latest = undefined; rendered = ''; $('conversation').replaceChildren();
      $('help').hidden = true; $('safety').hidden = true; $('handoff').hidden = true; $('activity').hidden = true; $('project-link').hidden = true;
      $('prompt').value = ''; pendingMessage = undefined;
      void connect();
    });
    events.onopen = async () => {
      try {
        const response = await fetch('/api/session'); const renewed = await response.json();
        if (current !== generation) return;
        resetToken = renewed.resetToken;
        if (!response.ok) throw new Error(renewed.error);
        token = renewed.token; connected = true; showError(''); render(renewed.state);
      } catch (error) { if (current === generation) { events.close(); disconnected(error.message); } }
    };
    events.onerror = () => { if (current !== generation) return; connected = false; if (latest) render(latest); };
  } catch (error) { if (current === generation) disconnected(error.message); }
}
$('new-session').addEventListener('click', async () => {
  if (sending || latest?.busy) return;
  sending = true; $('new-session').disabled = true; showError('');
  try {
    // Obtain a reset-only capability even when this browser does not own the old chat.
    if (!resetToken) { const response = await fetch('/api/session'); resetToken = (await response.json()).resetToken; }
    if (!resetToken) throw new Error('Cannot reach the local backend. Start it, then try New session again.');
    ++generation; events?.close(); connected = false;
    const response = await fetch('/api/new-session', { method: 'POST', headers: { 'x-tinkercua-token': resetToken } });
    const session = await response.json(); if (!response.ok) throw new Error(session.error || 'Could not start a new session.');
    latest = undefined; rendered = ''; pendingMessage = undefined; $('prompt').value = ''; safetyKey = '';
    token = session.token; resetToken = session.resetToken; connected = true; render(session.state);
    await connect(); $('prompt').focus();
  } catch (error) { const message = error.message; await connect(); showError(message); }
  finally { sending = false; $('new-session').disabled = false; if (latest) render(latest); if (connected) $('prompt').focus(); }
});
void connect();
