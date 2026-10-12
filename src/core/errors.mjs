/** An error the API answers with its own HTTP status. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
