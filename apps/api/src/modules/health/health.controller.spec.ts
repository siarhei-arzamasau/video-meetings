import { Test } from '@nestjs/testing';

import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    controller = moduleRef.get(HealthController);
  });

  it('reports ok with service metadata', () => {
    const result = controller.check();

    expect(result.status).toBe('ok');
    expect(result.service).toBe('api');
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('stamps a parseable ISO 8601 timestamp', () => {
    const { timestamp } = controller.check();

    expect(Number.isNaN(Date.parse(timestamp))).toBe(false);
    expect(new Date(timestamp).toISOString()).toBe(timestamp);
  });
});
