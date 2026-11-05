export class ServiceError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
