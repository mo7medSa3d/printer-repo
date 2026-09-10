/**
 * Client-safe server-action failure with an explicit HTTP status.
 * Lives outside the "use server" module (which may only export async
 * functions); routes import it to map action failures to responses without
 * echoing arbitrary internal error text.
 */
export class ActionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
