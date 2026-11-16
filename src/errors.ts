/** Errors whose message is safe and useful to show to the model/user as-is. */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends UserFacingError {}
export class NotFoundError extends UserFacingError {}
export class UpstreamError extends UserFacingError {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryable = false,
  ) {
    super(message);
  }
}
