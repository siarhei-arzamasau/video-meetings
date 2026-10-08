import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

import { ENV_FILE_PATHS } from '../../src/config/env-values';
import { MeetingDigestsModule } from '../../src/modules/meeting-digests/meeting-digests.module';
import {
  GeneratedMeetingDigest,
  MeetingDigestGenerator,
} from '../../src/modules/meeting-digests/services/meeting-digest-generator';

const AUTH_TOKEN_VARIABLE = 'ANTHROPIC_AUTH_TOKEN';

interface Measurement {
  label: string;
  characters: number;
  seconds: number;
  digest: GeneratedMeetingDigest;
}

/**
 * `MeetingDigestGenerator` over Anthropic's real API, for the `test:live` specs: the module
 * as the API builds it, the token as the API reads it, and a note of what every generation
 * took — which is what a time limit and a cap are set from.
 *
 * The token comes from the env files and never from the shell, for the reason
 * `claude-agent.live-spec.ts` gives where it does the same.
 */
export class LiveMeetingDigest {
  private readonly measurements: Measurement[] = [];

  private constructor(
    private readonly testingModule: TestingModule,
    private readonly generator: MeetingDigestGenerator,
    private readonly config: ConfigService,
    private readonly configuredToken: string | undefined,
  ) {}

  static async start(): Promise<LiveMeetingDigest> {
    delete process.env[AUTH_TOKEN_VARIABLE];

    const testingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ENV_FILE_PATHS }),
        MeetingDigestsModule,
      ],
    }).compile();
    const config = testingModule.get(ConfigService);

    return new LiveMeetingDigest(
      testingModule,
      testingModule.get(MeetingDigestGenerator),
      config,
      config.get<string>(AUTH_TOKEN_VARIABLE),
    );
  }

  /** One generation, measured. `label` is the row it prints as when the suite ends. */
  async generateFrom(label: string, transcripts: string[]): Promise<GeneratedMeetingDigest> {
    const characters = transcripts.reduce((total, transcript) => total + transcript.length, 0);
    const startedAt = performance.now();
    const digest = await this.generator.generate(transcripts, new AbortController().signal);

    this.measurements.push({
      label,
      characters,
      seconds: (performance.now() - startedAt) / 1_000,
      digest,
    });

    return digest;
  }

  useToken(authToken: string): void {
    this.config.set(AUTH_TOKEN_VARIABLE, authToken);
  }

  restoreToken(): void {
    this.config.set(AUTH_TOKEN_VARIABLE, this.configuredToken);
  }

  /** Prints the numbers where a run can be read, in the columns of the defaults file's table. */
  async close(): Promise<void> {
    const rows = this.measurements.map(
      ({ label, characters, seconds, digest }) =>
        `${label}: ${characters} characters, ${digest.inputTokens} tokens in, ` +
        `${digest.outputTokens} out, ${seconds.toFixed(1)} s, $${digest.costUsd.toFixed(4)}, ` +
        digest.model,
    );

    if (rows.length > 0) {
      process.stdout.write(`\nMeeting digest measurements\n${rows.join('\n')}\n`);
    }

    await this.testingModule.close();
  }
}
