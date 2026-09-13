import { readFileSync } from 'node:fs';
import type { FunctionTool } from 'openai/resources/responses/responses';
import { z } from 'zod';

export const resultSchema = z.object({
  completed: z.array(z.string().max(1000)).max(20),
  verified: z.array(z.string().max(1000)).max(20),
  unverified: z.array(z.string().max(1000)).max(20),
  needsAttention: z.boolean(),
}).strict();
export type Result = z.infer<typeof resultSchema>;
export const helpSchema = z.object({ reason: z.string().trim().min(1).max(300), action: z.string().trim().min(1).max(500) }).strict();
export type HelpRequest = z.infer<typeof helpSchema>;
export const helpTool: FunctionTool = {
  type: 'function', name: 'request_help', strict: true,
  description: 'Pause immediately for human help when stuck. Explain the observed blocker and ask for one specific action in Tinkercad or one clarification in chat. The user can fix the screen and click Continue, or reply in chat. No further computer actions will run until the user responds.',
  parameters: { type: 'object', properties: { reason: { type: 'string' }, action: { type: 'string' } }, required: ['reason', 'action'], additionalProperties: false },
};
export const reportTool: FunctionTool = {
  type: 'function', name: 'finish_report', strict: true,
  description: 'Finish this run with evidence separated from work performed. Use needsAttention when blocked or requesting human help. Verified entries must reference actual screenshot observations or visually inspected code, and distinguish those evidence types. Exact timing is not measured by this tool.',
  parameters: { type: 'object', properties: {
    completed: { type: 'array', items: { type: 'string' } }, verified: { type: 'array', items: { type: 'string' } },
    unverified: { type: 'array', items: { type: 'string' } }, needsAttention: { type: 'boolean' },
  }, required: ['completed', 'verified', 'unverified', 'needsAttention'], additionalProperties: false },
};
export const milestoneSchema = z.object({ phase: z.enum(['creating_project', 'building', 'simulating']), message: z.string().min(1).max(300) }).strict();
export type Milestone = z.infer<typeof milestoneSchema>;
export const progressTool: FunctionTool = {
  type: 'function', name: 'report_progress', strict: true,
  description: 'Report a concise milestone actually observed in the current screenshots, then continue working. Never fabricate progress or report intended work as completed.',
  parameters: { type: 'object', properties: { phase: { type: 'string', enum: ['creating_project', 'building', 'simulating'] }, message: { type: 'string' } }, required: ['phase', 'message'], additionalProperties: false },
};
export function instructions() {
  return readFileSync(new URL('../recipes/arduino-led.md', import.meta.url), 'utf8');
}
