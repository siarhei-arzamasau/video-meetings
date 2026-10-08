import { ConfigService } from '@nestjs/config';

import { ClaudeAgentFailure, ClaudeModel } from '../claude-agent.constants';
import {
  answering,
  AUTH_TOKEN,
  AUTH_TOKEN_VARIABLE,
  claudeAgentOver,
  requestOf,
  STRUCTURED_PROMPT,
} from './claude-agent-process.fixture';
import { ClaudeAgentService } from './claude-agent.service';

/**
 * What the service decides on its own side of the SDK: whether a process is started and what
 * it is started with — and, in `claude-agent.service.abort.spec.ts`, what becomes of a call
 * its caller hung up on. The process is scripted (`claude-agent-process.fixture.ts`), so
 * nothing here says how the real one behaves: that is `test/claude-agent.live-spec.ts`,
 * against the real API, because a scripted SDK only repeats back what a spec assumed about
 * it. What a result becomes is `claude-agent-outcome.spec.ts`.
 */
describe('ClaudeAgentService', () => {
  beforeEach(() => {
    // A token exported in the developer's shell would turn the unset case into a real request.
    delete process.env[AUTH_TOKEN_VARIABLE];
  });

  describe.each([
    ['unset', {}],
    ['empty, as a fresh copy of .env.example leaves it', { [AUTH_TOKEN_VARIABLE]: '' }],
  ])('while the token is %s', (_state, variables) => {
    const loadQuery = jest.fn();
    const claudeAgent = new ClaudeAgentService(new ConfigService(variables), { loadQuery });

    afterEach(() => {
      expect(loadQuery).not.toHaveBeenCalled();
    });

    // Without this refusal the SDK would go looking for another credential on the host — a
    // developer's own Claude login, typically — and bill that instead of failing.
    it('refuses to start Claude Code for a prompt', async () => {
      await expect(claudeAgent.runPrompt('Say hello.', ClaudeModel.SONNET)).rejects.toMatchObject({
        failure: ClaudeAgentFailure.NOT_CONFIGURED,
      });
    });

    it('refuses to start Claude Code for a schema-bound prompt', async () => {
      const neverAborted = new AbortController().signal;

      await expect(
        claudeAgent.runStructuredPrompt(STRUCTURED_PROMPT, neverAborted),
      ).rejects.toMatchObject({ failure: ClaudeAgentFailure.NOT_CONFIGURED });
    });
  });

  describe('what Claude Code is started with', () => {
    const VARIABLES_OF_THE_API = ['JWT_SECRET', 'DATABASE_URL', 'ANTHROPIC_BASE_URL'];

    beforeEach(() => {
      for (const name of VARIABLES_OF_THE_API) {
        process.env[name] = `the API's own ${name}`;
      }
    });

    afterEach(() => {
      for (const name of VARIABLES_OF_THE_API) {
        delete process.env[name];
      }
    });

    it.each<[string, (claudeAgent: ClaudeAgentService) => Promise<unknown>]>([
      ['a prompt', (claudeAgent) => claudeAgent.runPrompt('Say hello.', ClaudeModel.SONNET)],
      [
        'a schema-bound prompt',
        (claudeAgent) =>
          claudeAgent.runStructuredPrompt(STRUCTURED_PROMPT, new AbortController().signal),
      ],
    ])(
      'is no tool, one turn, nothing from disk, and none of the environment for %s',
      async (_call, run) => {
        const { claudeAgent, started } = claudeAgentOver(answering);

        await run(claudeAgent);

        const { prompt, options } = requestOf(started);

        expect(prompt).toBe('Say hello.');
        expect(options).toMatchObject({
          model: ClaudeModel.SONNET,
          permissionMode: 'dontAsk',
          maxTurns: 1,
          strictMcpConfig: true,
          persistSession: false,
        });
        expect(options.tools).toEqual([]);
        expect(options.settingSources).toEqual([]);
        // Named one by one: a variable added to what the process inherits is a decision, and
        // this is where it has to be written down.
        expect(Object.keys(options.env ?? {}).toSorted()).toEqual(
          [AUTH_TOKEN_VARIABLE, 'HOME', 'LANG', 'PATH', 'TMPDIR'].toSorted(),
        );
        expect(options.env?.[AUTH_TOKEN_VARIABLE]).toBe(AUTH_TOKEN);
      },
    );

    it('binds the answer to the schema, under the system prompt it was given', async () => {
      const { claudeAgent, started } = claudeAgentOver(answering);

      await claudeAgent.runStructuredPrompt(STRUCTURED_PROMPT, new AbortController().signal);

      expect(requestOf(started).options).toMatchObject({
        systemPrompt: STRUCTURED_PROMPT.systemPrompt,
        outputFormat: { type: 'json_schema', schema: STRUCTURED_PROMPT.schema },
      });
    });
  });

  it('returns the text Claude answered, with its model and cost', async () => {
    const { claudeAgent } = claudeAgentOver(answering);

    await expect(claudeAgent.runPrompt('Say hello.', ClaudeModel.SONNET)).resolves.toEqual({
      text: '{"greeting":"Hello."}',
      model: 'claude-sonnet-5-5',
      costUsd: 0.0042,
    });
  });

  it('returns the object Claude answered through the schema, with its model, cost, and tokens', async () => {
    const { claudeAgent } = claudeAgentOver(answering);

    await expect(
      claudeAgent.runStructuredPrompt(STRUCTURED_PROMPT, new AbortController().signal),
    ).resolves.toEqual({
      output: { greeting: 'Hello.' },
      model: 'claude-sonnet-5-5',
      costUsd: 0.0042,
      inputTokens: 2100,
      outputTokens: 12,
    });
  });
});
