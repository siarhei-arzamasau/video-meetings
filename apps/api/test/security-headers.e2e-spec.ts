import { useApiSuite } from './utils/api-suite';
import { MEETINGS_URL } from './utils/fixtures';

/**
 * The headers `configure-app.ts` puts on every answer — asserted on the answers that matter
 * most: an open route, and a refusal, which is what an attacker probing the API mostly gets.
 */
describe('security headers', () => {
  const suite = useApiSuite();

  it.each([
    ['an open route', () => suite.get('/api/health').expect(200)],
    ['a refused request', () => suite.get(MEETINGS_URL).expect(401)],
  ])('are on %s', async (_description, send) => {
    const { headers } = await send();

    // Nothing an API response could load, run, or be framed by, were it ever rendered.
    expect(headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none'");
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['x-powered-by']).toBeUndefined();
    // Left to whatever terminates TLS.
    expect(headers['strict-transport-security']).toBeUndefined();
  });
});
