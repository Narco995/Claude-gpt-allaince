import { z } from "zod";

/** Agents that can participate in a bridge session. Open string so new models need no core change. */
export const AgentIdSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_.:-]+$/);

export const MessageTypeSchema = z.enum([
  "directive", "result", "critique", "revision", "tool_call", "tool_result", "info", "error",
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

/** Structured agent-to-agent message. Every exchange in a session is recorded in this envelope. */
export const AgentMessageSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  workflowId: z.string().uuid().optional(),
  from: AgentIdSchema,
  to: AgentIdSchema,
  type: MessageTypeSchema,
  content: z.string(),
  structured: z.record(z.string(), z.unknown()).optional(),
  parentId: z.string().uuid().optional(),
  createdAt: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const CritiqueSchema = z.object({
  verdict: z.enum(["approve", "revise", "reject"]),
  score: z.number().min(0).max(10).optional(),
  summary: z.string().min(1),
  issues: z.array(z.object({
    severity: z.enum(["low", "medium", "high"]).default("medium"),
    description: z.string().min(1),
    suggestion: z.string().optional(),
  })).default([]),
});
export type Critique = z.infer<typeof CritiqueSchema>;
