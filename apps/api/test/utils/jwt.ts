import { createHmac, timingSafeEqual } from 'node:crypto';

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

export type HmacAlgorithm = 'HS256' | 'HS512';

/**
 * Verifies and decodes an HS256 JWT using only `node:crypto`.
 *
 * Deliberately does not use the library the API signs with. A token checked by the same
 * code that produced it proves the two agree, not that the token is a valid JWT — this
 * reads the wire format independently, so a token only `@nestjs/jwt` can understand fails
 * here. Verified against a signature produced by `openssl dgst -sha256 -hmac`.
 *
 * @throws if the token is malformed, is not HS256, or does not verify against `secret`.
 */
export function verifyJwtHs256(token: string, secret: string): DecodedJwt {
  const segments = token.split('.');
  const [headerSegment, payloadSegment, signatureSegment] = segments;

  if (
    segments.length !== 3 ||
    headerSegment === undefined ||
    payloadSegment === undefined ||
    signatureSegment === undefined
  ) {
    throw new Error(`Expected a three-segment JWT, received ${String(segments.length)} segment(s)`);
  }

  const header = decodeJsonSegment(headerSegment, 'header');
  const alg = header['alg'];

  if (alg !== 'HS256') {
    throw new Error(`Expected the token to be signed with HS256, got ${JSON.stringify(alg)}`);
  }

  const expected = createHmac('sha256', secret)
    .update(`${headerSegment}.${payloadSegment}`)
    .digest();
  const actual = Buffer.from(signatureSegment, 'base64url');

  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('JWT signature does not verify against the expected secret');
  }

  return { header, payload: decodeJsonSegment(payloadSegment, 'payload') };
}

/**
 * Mints a token the tests control, for the cases a real login cannot produce: a wrong
 * secret, an unexpected algorithm, an expiry in the past, a subject that no longer exists.
 */
export function signJwtHmac(
  payload: Record<string, unknown>,
  secret: string,
  algorithm: HmacAlgorithm = 'HS256',
): string {
  const header = encodeSegment({ alg: algorithm, typ: 'JWT' });
  const body = encodeSegment(payload);
  const digest = algorithm === 'HS256' ? 'sha256' : 'sha512';
  const signature = createHmac(digest, secret).update(`${header}.${body}`).digest('base64url');

  return `${header}.${body}.${signature}`;
}

/**
 * An `alg: none` token with an empty signature — the classic algorithm-confusion attack.
 * A verifier that trusts the header's `alg` accepts this and hands the caller whatever
 * `sub` they asked for.
 */
export function unsignedJwt(payload: Record<string, unknown>): string {
  return `${encodeSegment({ alg: 'none', typ: 'JWT' })}.${encodeSegment(payload)}.`;
}

function encodeSegment(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeJsonSegment(segment: string, label: string): Record<string, unknown> {
  const json = Buffer.from(segment, 'base64url').toString('utf8');
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`JWT ${label} is not valid JSON: ${json}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`JWT ${label} is not a JSON object: ${json}`);
  }

  return parsed as Record<string, unknown>;
}
