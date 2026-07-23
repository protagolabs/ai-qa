import { z } from "zod";

export const criterionIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);

export const eventIdSchema = z
  .string()
  .regex(/^event-[a-z0-9][a-z0-9-]{0,126}$/);

export const actionIdSchema = eventIdSchema;

export const stepIdSchema = z.string().regex(/^step-[a-z0-9][a-z0-9-]{0,126}$/);

export const runIdSchema = z.string().regex(/^run-[a-z0-9][a-z0-9-]{0,62}$/);
