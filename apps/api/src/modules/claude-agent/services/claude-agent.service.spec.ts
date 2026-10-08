import { ConfigService } from '@nestjs/config';

import { ClaudeAgentFailure, ClaudeModel } from '../claude-agent.constants';
import { ClaudeAgentService } from './claude-agent.service';

const AUTH_TOKEN_VARIABLE = 'ANTHROPIC_AUTH_TOKEN';

/**
 * Only what the service decides before anything is sent. What happens once a request leaves
 * is `test/claude-agent.live-spec.ts`, against the real API, because a mocked SDK would only
 * repeat back what this file assumed about it.
 */
describe('ClaudeAgentService', () => {
  beforeEach(() => {
    // A token exported in the developer's shell would turn the unset case into a real request.
    delete process.env[AUTH_TOKEN_VARIABLE];
  });

  it.each([
    ['unset', {}],
    ['empty, as a fresh copy of .env.example leaves it', { [AUTH_TOKEN_VARIABLE]: '' }],
  ])('refuses to start Claude Code while the token is %s', async (_state, variables) => {
    const claudeAgent = new ClaudeAgentService(new ConfigService(variables));

    // Without this refusal the SDK would go looking for another credential on the host — a
    // developer's own Claude login, typically — and bill that instead of failing.
    await expect(claudeAgent.runPrompt('Say hello.', ClaudeModel.SONNET)).rejects.toMatchObject({
      failure: ClaudeAgentFailure.NOT_CONFIGURED,
    });
  });
});
