import { ExecutionContext, UnauthorizedException } from '@nestjs/common';

import type { AccessTokenVerifier } from '../auth/services/access-token.verifier';
import { McpAuthGuard, McpRequest } from './mcp-auth.guard';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'header.payload.signature';

const requestWith = (authorization?: string): McpRequest =>
  ({ headers: { authorization } }) as McpRequest;

const contextOf = (request: McpRequest): ExecutionContext =>
  ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;

/**
 * What the guard does with the verifier's answer. Which tokens the verifier refuses is
 * `access-token.verifier.spec.ts`'s, and what the route answers is the e2e specs'.
 */
describe('McpAuthGuard', () => {
  const subjectOf = jest.fn();
  const guard = new McpAuthGuard({ subjectOf } as unknown as AccessTokenVerifier);

  beforeEach(() => {
    subjectOf.mockReset().mockResolvedValue(USER_ID);
  });

  it('lets in a request whose bearer token verifies, as the user the token names', async () => {
    const request = requestWith(`Bearer ${TOKEN}`);

    await expect(guard.canActivate(contextOf(request))).resolves.toBe(true);

    expect(subjectOf).toHaveBeenCalledWith(TOKEN);
    // The id, and nothing else: no user is read to fill in the rest.
    expect(request.requester).toEqual({ userId: USER_ID });
  });

  it('refuses a token the verifier refuses, and names nobody on the request', async () => {
    const request = requestWith(`Bearer ${TOKEN}`);
    subjectOf.mockResolvedValue(null);

    await expect(guard.canActivate(contextOf(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(request.requester).toBeUndefined();
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['another scheme', `Basic ${TOKEN}`],
    ['the scheme in another case', `bearer ${TOKEN}`],
    ['the scheme and no token', 'Bearer '],
    ['the token and no scheme', TOKEN],
    ['two tokens', `Bearer ${TOKEN} ${TOKEN}`],
  ])('refuses %s without asking the verifier', async (_case, authorization) => {
    const request = requestWith(authorization);

    await expect(guard.canActivate(contextOf(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(subjectOf).not.toHaveBeenCalled();
    expect(request.requester).toBeUndefined();
  });
});
