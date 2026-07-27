export class RevisorError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RevisorError";
  }
}
