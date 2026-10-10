/**
 * The token of an `Authorization: Bearer <token>` header, or `undefined` for a header that
 * is absent or is anything else — another scheme, no token, or more than one.
 *
 * Stated once for every guard that takes an access token, so that no two of them disagree
 * about what a header has to look like before a token is even verified.
 */
export function bearerTokenOf(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }

  const [scheme, value, ...rest] = header.split(' ');

  if (scheme !== 'Bearer' || value === undefined || value.length === 0 || rest.length > 0) {
    return undefined;
  }

  return value;
}
