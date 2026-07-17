import { z } from "zod";
import { EventType } from "./enums.js";
import { Id, Timestamp } from "./entities.js";

/**
 * Canonical event envelope. Events are append-only; `seq` is a monotonically
 * increasing integer per AvityOS instance so clients can resume a stream
 * after reconnecting (`?afterSeq=`) without missing or duplicating events.
 */
export const EventEnvelope = z.object({
  schemaVersion: z.literal(1),
  seq: z.number().int().min(1),
  id: Id,
  type: EventType,
  projectId: Id.nullable(),
  missionId: Id.nullable(),
  runId: Id.nullable(),
  createdAt: Timestamp,
  payload: z.record(z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

export const EventStreamQuery = z.object({
  afterSeq: z.coerce.number().int().min(0).default(0),
  projectId: Id.optional(),
  types: z.string().optional(),
});
export type EventStreamQuery = z.infer<typeof EventStreamQuery>;
