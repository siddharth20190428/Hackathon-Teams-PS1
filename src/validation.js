import { z } from 'zod';
import { httpError } from './errors.js';

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'must be an email address');

// .strict() rejects unknown fields, and string-only fields reject objects such as
// { "$ne": null } before anything reaches the database.
export const registerSchema = z
  .object({
    email,
    password: z.string().min(8).max(128),
    displayName: z.string().trim().min(1).max(60),
    skills: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
    utcOffsetMinutes: z.number().int().min(-720).max(840).optional(),
  })
  .strict();

// Profile edit: any of these, at least one. Same rules as registration; skills are de-duplicated.
export const updateProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(60).optional(),
    skills: z
      .array(z.string().trim().min(1).max(30))
      .max(10)
      .transform((list) => [...new Set(list)])
      .optional(),
    utcOffsetMinutes: z.number().int().min(-720).max(840).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change' });

// The invite code is typed by hand, so any string up to a sane length is accepted here and the
// format check (and the look-alike mapping) happens in joinByCode. Anything that is not a
// string, such as { "$ne": null }, an array or a number, stops here.
export const joinByCodeSchema = z.object({ code: z.string().max(64) }).strict();

// ?limit=N on lists: digits only, 1..max. "abc", "-1", "1e2", "0x10", "2.5" and repeated
// parameters (which Express turns into an array) are all rejected rather than guessed at.
export const limitQuery = (max, fallback) =>
  z.object({
    limit: z
      .string()
      .regex(/^\d{1,3}$/, 'must be a whole number')
      .transform(Number)
      .pipe(z.number().int().min(1).max(max))
      .optional()
      .transform((n) => n ?? fallback),
  });

export const loginSchema = z.object({ email, password: z.string().min(1).max(128) }).strict();

export const createTeamSchema = z.object({ name: z.string().trim().min(1).max(60) }).strict();

// Throws a 400 with the list of problems (field and message, never the submitted value).
export function parse(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    throw httpError(
      400,
      'VALIDATION_ERROR',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}
