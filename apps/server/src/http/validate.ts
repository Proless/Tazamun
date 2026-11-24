import type { Context } from 'hono';
import type { z } from 'zod';
import { ApiError } from './errors.ts';

/**
 * Describe validation issues by path and code only. Never include values: they may be
 * ciphertext, tokens or auth keys (rule 5), and error bodies can end up in client logs.
 */
function describe(error: z.ZodError): string {
  const issues = error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(body)';
    return `${path}: ${issue.code}`;
  });
  return `Invalid request: ${issues.join(', ')}`;
}

export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'INVALID_REQUEST', describe(result.error));
  return result.data;
}

/** Read and validate a JSON body. */
export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError(400, 'INVALID_REQUEST', 'The request body must be JSON.');
  }
  return parse(schema, body);
}
