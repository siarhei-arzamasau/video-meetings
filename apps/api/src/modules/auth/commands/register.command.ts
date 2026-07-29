/**
 * Primitives, not the DTO: a DTO is an HTTP-transport object carrying class-validator
 * decorators, and a handler that accepted one could not be exercised without building a
 * web-layer object.
 */
export class RegisterCommand {
  constructor(
    readonly email: string,
    readonly password: string,
  ) {}
}
