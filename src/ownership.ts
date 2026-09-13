import { randomBytes } from 'node:crypto';
import { Attention } from './actions.js';
/** One local conversation owns the dedicated profile until an explicit reset. */
export class Ownership {
  constructor(private owner?: string) {}
  snapshot() { return this.owner; }
  token = randomBytes(32).toString('hex');
  resetToken = randomBytes(32).toString('hex');
  newSession(token: string) {
    if (token !== this.resetToken) throw new Attention('Refresh this page before starting a new session.');
    this.owner = undefined; this.token = randomBytes(32).toString('hex'); this.resetToken = randomBytes(32).toString('hex');
    return this.connect();
  }
  private read(cookie = '') { return cookie.split(';').map(p => p.trim()).find(p => p.startsWith('tinkercua_session='))?.slice('tinkercua_session='.length); }
  owns(cookie?: string) { return !!this.owner && this.read(cookie) === this.owner; }
  connect(cookie?: string) {
    if (this.owner && !this.owns(cookie)) throw new Attention('This browser session belongs to another chat. Click New session to start fresh. Your Tinkercad login and existing circuits will be kept.');
    if (!this.owner) this.owner = randomBytes(32).toString('hex');
    return `tinkercua_session=${this.owner}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
  }
}
