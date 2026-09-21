/**
 * An error the user can act on (bad usage, missing setup). The CLI prints the
 * message without a stack trace and exits with {@link UserError.exitCode} (2).
 */
export class UserError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

export function isUserError(err: unknown): err is UserError {
  return err instanceof UserError;
}
