/** An error a NearKit service raises with its own code (the demo's simulated failures). */
export class ServiceError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'ServiceError'
  }
}
