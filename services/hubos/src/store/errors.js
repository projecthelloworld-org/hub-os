export class StoreError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "StoreError";
    this.status = status;
  }
}
