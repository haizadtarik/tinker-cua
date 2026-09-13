import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';

export class Attention extends Error {}
const point = { x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() };
const modifiers = { keys: z.array(z.string().max(30)).max(5).nullish() };
const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), ...point, ...modifiers, button: z.enum(['left', 'right', 'wheel']) }).strict(),
  z.object({ type: z.literal('double_click'), ...point, ...modifiers }).strict(),
  z.object({ type: z.literal('move'), ...point, ...modifiers }).strict(),
  z.object({ type: z.literal('drag'), path: z.array(z.object(point)).min(2).max(200), ...modifiers }).strict(),
  z.object({ type: z.literal('scroll'), ...point, ...modifiers, scroll_x: z.number().finite().min(-2000).max(2000), scroll_y: z.number().finite().min(-2000).max(2000) }).strict(),
  z.object({ type: z.literal('keypress'), keys: z.array(z.string().max(30)).min(1).max(5) }).strict(),
  z.object({ type: z.literal('type'), text: z.string().max(12000) }).strict(),
  z.object({ type: z.literal('wait') }).strict(),
  z.object({ type: z.literal('screenshot') }).strict(),
]);
export type Action = z.infer<typeof actionSchema>;
export function mapKey(key: string): string {
  const aliases: Record<string, string> = { CMD: 'Meta', COMMAND: 'Meta', META: 'Meta', CTRL: 'Control', CONTROL: 'Control', ALT: 'Alt', OPTION: 'Alt', SHIFT: 'Shift', ENTER: 'Enter', RETURN: 'Enter', ESC: 'Escape', ESCAPE: 'Escape', SPACE: 'Space', TAB: 'Tab', BACKSPACE: 'Backspace', DELETE: 'Delete', DEL: 'Delete', ARROWUP: 'ArrowUp', ARROWDOWN: 'ArrowDown', ARROWLEFT: 'ArrowLeft', ARROWRIGHT: 'ArrowRight', UP: 'ArrowUp', DOWN: 'ArrowDown', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight', HOME: 'Home', END: 'End', PAGEUP: 'PageUp', PAGEDOWN: 'PageDown' };
  if (aliases[key.toUpperCase()]) return aliases[key.toUpperCase()];
  if (/^[a-z0-9]$/i.test(key)) return key.toLowerCase();
  throw new Attention(`Unsupported key: ${key}`);
}
export function parseAction(input: unknown, width: number, height: number): Action {
  const a = actionSchema.parse(input);
  const points = a.type === 'drag' ? a.path : 'x' in a ? [a] : [];
  if (points.some(p => p.x >= width || p.y >= height)) throw new Attention('Action is outside the observed viewport.');
  if ('keys' in a && a.keys) {
    const keys = a.keys.map(mapKey);
    if (a.type !== 'keypress' && keys.some(k => !['Meta', 'Control', 'Alt', 'Shift'].includes(k))) throw new Attention('Mouse modifiers must be modifier keys.');
    const modified = keys.some(k => ['Meta', 'Control', 'Alt'].includes(k));
    if (modified && keys.some(k => ['l', 't', 'n', 'w', 'q', 'r', 'o', 's', 'p', 'j', 'u', 'i', 'ArrowLeft', 'ArrowRight', 'Tab', 'Home'].includes(k))) throw new Attention('Browser or system shortcut is outside the circuit task.');
  }
  return a;
}
export function projectId(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || !['www.tinkercad.com', 'tinkercad.com'].includes(u.hostname) || u.port || u.username || u.password) return null;
    return u.pathname.match(/^\/things\/([a-zA-Z0-9]+)(?:-[^/]*)?\/editel\/?$/)?.[1] || null;
  } catch { return null; }
}
export async function pause(ms: number, signal: AbortSignal) {
  signal.throwIfAborted(); await delay(ms, undefined, { signal }); signal.throwIfAborted();
}
export async function executeBatch(inputs: unknown[], options: {
  signal: AbortSignal; remaining: number; width: number; height: number;
  execute: (action: Action) => Promise<void>;
}) {
  if (inputs.length > options.remaining || inputs.length > 30) throw new Attention('Action limit reached. Inspect the circuit before continuing.');
  const actions = inputs.map(a => parseAction(a, options.width, options.height));
  for (const action of actions) { options.signal.throwIfAborted(); await options.execute(action); }
  options.signal.throwIfAborted();
}
