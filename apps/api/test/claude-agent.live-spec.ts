import { randomUUID } from 'node:crypto';

import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

import { ENV_FILE_PATHS } from '../src/config/env-values';
import {
  ClaudeAgentFailure,
  ClaudeModel,
} from '../src/modules/claude-agent/claude-agent.constants';
import { ClaudeAgentModule } from '../src/modules/claude-agent/claude-agent.module';
import { ClaudeAgentService } from '../src/modules/claude-agent/services/claude-agent.service';

const AUTH_TOKEN_VARIABLE = 'ANTHROPIC_AUTH_TOKEN';
const NEVER_ISSUED_TOKEN = 'sk-ant-api03-never-issued-by-anthropic';

/**
 * The Claude Agent SDK against Anthropic's real API — nothing here is mocked or replayed, so
 * every test spends a real request and needs the network and a working `ANTHROPIC_AUTH_TOKEN`.
 * That is why this is `test:live` and neither `pnpm test` nor `test:e2e` picks it up.
 *
 * The token is read from the env files `AppModule` names, through `ConfigService`, and from
 * nowhere else: one exported in the shell is dropped before the files are loaded.
 */
describe('ClaudeAgentService against the real Anthropic API', () => {
  let testingModule: TestingModule;
  let claudeAgent: ClaudeAgentService;
  let config: ConfigService;
  let configuredToken: string | undefined;

  beforeAll(async () => {
    // `ConfigModule` lets a variable already in `process.env` win over the env files — right
    // for the API, wrong here: a token exported in the developer's shell, their own or a
    // gateway's, would be the one this run spends, whatever the file says. Jest gives each
    // spec file its own `process.env`, so this reaches nothing outside this suite.
    delete process.env[AUTH_TOKEN_VARIABLE];

    testingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ENV_FILE_PATHS }),
        ClaudeAgentModule,
      ],
    }).compile();

    claudeAgent = testingModule.get(ClaudeAgentService);
    config = testingModule.get(ConfigService);
    configuredToken = config.get<string>(AUTH_TOKEN_VARIABLE);
  });

  afterEach(() => {
    config.set(AUTH_TOKEN_VARIABLE, configuredToken);
  });

  afterAll(async () => {
    await testingModule.close();
  });

  it('gets an answer to a prompt from Sonnet', async () => {
    // Minted per run, so the answer can only have come from a model that read this prompt.
    const nonce = randomUUID();

    const reply = await claudeAgent.runPrompt(
      `Reply with exactly this text and nothing else: ${nonce}`,
      ClaudeModel.SONNET,
    );

    expect(reply.text).toContain(nonce);
    expect(reply.model).toContain(ClaudeModel.SONNET);
    expect(reply.costUsd).toBeGreaterThan(0);
  });

  it('gets an object bound to a schema, in the one turn every call is given', async () => {
    const nonce = randomUUID();
    const neverAborted = new AbortController().signal;

    const reply = await claudeAgent.runStructuredPrompt(
      {
        model: ClaudeModel.SONNET,
        systemPrompt: 'You repeat back what you are given, through the structured output.',
        prompt: `Put exactly this text in "echo": ${nonce}`,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['echo'],
          properties: { echo: { type: 'string' } },
        },
      },
      neverAborted,
    );

    // The answer is the object, not text to be parsed — and it arrived under `maxTurns: 1`,
    // which is the measurement `SINGLE_TURN` in the service is explained by.
    expect(reply.output).toEqual({ echo: nonce });
    expect(reply.model).toContain(ClaudeModel.SONNET);
    expect(reply.costUsd).toBeGreaterThan(0);
    expect(reply.inputTokens).toBeGreaterThan(0);
  });

  it('reports a prompt no model could read as too long, having spent nothing on it', async () => {
    // About 1.3 million tokens, past the largest context window there is. Claude Code turns
    // it away itself, so this is the one test here that sends nothing to Anthropic.
    const prompt = 'The quick brown fox jumps over the lazy dog. '.repeat(120_000);

    await expect(
      claudeAgent.runStructuredPrompt(
        {
          model: ClaudeModel.SONNET,
          systemPrompt: 'Summarise what you are given.',
          prompt,
          schema: { type: 'object', properties: { summary: { type: 'string' } } },
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ failure: ClaudeAgentFailure.PROMPT_TOO_LONG, costUsd: 0 });
  });

  it('hangs up on Claude when the call is called off, rather than waiting the answer out', async () => {
    const timeLimit = new AbortController();
    // An answer that takes the better part of a minute to write, so that a call which only
    // stopped listening would still be running long after this test has been failed.
    const essay = claudeAgent.runStructuredPrompt(
      {
        model: ClaudeModel.SONNET,
        systemPrompt: 'You write long essays, through the structured output.',
        prompt: 'Write a three-thousand-word essay on the history of the bicycle in "essay".',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['essay'],
          properties: { essay: { type: 'string' } },
        },
      },
      timeLimit.signal,
    );
    // Long enough for the process to have started and sent its request.
    const calledOffAt = await new Promise<number>((resolve) => {
      setTimeout(() => {
        timeLimit.abort(new Error('The time limit passed'));
        resolve(performance.now());
      }, 1_500);
    });

    await expect(essay).rejects.toMatchObject({ failure: ClaudeAgentFailure.FAILED });
    // The SDK's grace is about two seconds; the essay is not.
    expect(performance.now() - calledOffAt).toBeLessThan(6_000);
  });

  it('is refused with a token Anthropic never issued', async () => {
    // What makes the test above evidence about the configured token: were the SDK quietly
    // using a credential it found elsewhere on this machine, this call would succeed too.
    config.set(AUTH_TOKEN_VARIABLE, NEVER_ISSUED_TOKEN);

    await expect(claudeAgent.runPrompt('Say hello.', ClaudeModel.SONNET)).rejects.toMatchObject({
      failure: ClaudeAgentFailure.AUTHENTICATION,
    });
  });
});
