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

  it('is refused with a token Anthropic never issued', async () => {
    // What makes the test above evidence about the configured token: were the SDK quietly
    // using a credential it found elsewhere on this machine, this call would succeed too.
    config.set(AUTH_TOKEN_VARIABLE, NEVER_ISSUED_TOKEN);

    await expect(claudeAgent.runPrompt('Say hello.', ClaudeModel.SONNET)).rejects.toMatchObject({
      failure: ClaudeAgentFailure.AUTHENTICATION,
    });
  });
});
