import request from 'supertest';

import { useApiSuite } from './utils/api-suite';
import { MEETINGS_URL, TEST_WEB_ORIGIN } from './utils/fixtures';

const HEALTH_URL = '/api/health';
const FOREIGN_ORIGIN = 'https://attacker.example';

/**
 * The origin allowlist, as a browser meets it. Supertest sends no `Origin` of its own, so every
 * other spec is blind to CORS; these set one. The run allows exactly `TEST_WEB_ORIGIN`
 * (`setup-env.ts`).
 */
describe('CORS', () => {
  const suite = useApiSuite();

  const preflight = (origin: string) =>
    request(suite.app().getHttpServer())
      .options(MEETINGS_URL)
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');

  it('answers the web app origin with the headers that let its page read the response', async () => {
    const response = await suite.get(HEALTH_URL).set('Origin', TEST_WEB_ORIGIN).expect(200);

    expect(response.headers['access-control-allow-origin']).toBe(TEST_WEB_ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('names no other origin as allowed, so a page there cannot read the answer', async () => {
    const response = await suite.get(HEALTH_URL).set('Origin', FOREIGN_ORIGIN).expect(200);

    // The one header a browser checks before handing a page the response. The `cors` package
    // sends `Access-Control-Allow-Credentials` to every origin, and without this it grants
    // nothing.
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lets the web app preflight an authenticated write', async () => {
    const response = await preflight(TEST_WEB_ORIGIN).expect(204);

    expect(response.headers['access-control-allow-origin']).toBe(TEST_WEB_ORIGIN);
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    expect(response.headers['access-control-allow-headers']).toContain('authorization');
  });

  it('gives a preflight from any other origin nothing to proceed on', async () => {
    const response = await preflight(FOREIGN_ORIGIN);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
