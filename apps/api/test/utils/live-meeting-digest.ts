import { ConfigModule, ConfigService } from '@nestjs/config';
import { CommandBus } from '@nestjs/cqrs';
import { Test, TestingModule } from '@nestjs/testing';

import { ENV_FILE_PATHS } from '../../src/config/env-values';
import { DEFAULT_MEETING_DIGEST_MAX_TOOL_CALLS } from '../../src/config/meeting-digest.defaults';
import { ClaudeAgentModule } from '../../src/modules/claude-agent/claude-agent.module';
import { MeetingDigestRevisionOutcome } from '../../src/modules/meeting-digests/commands/revise-meeting-digest.command';
import {
  GeneratedMeetingDigest,
  MeetingDigestGenerator,
} from '../../src/modules/meeting-digests/services/meeting-digest-generator';

import { MeetingToolsModule } from '../../src/modules/meeting-tools/meeting-tools.module';
import { TaskService } from '../../src/modules/tasks/services/task.service';
import { LiveMeetingTasks } from './live-meeting-tasks';

const AUTH_TOKEN_VARIABLE = 'ANTHROPIC_AUTH_TOKEN';
const MAX_TOOL_CALLS_VARIABLE = 'MEETING_DIGEST_MAX_TOOL_CALLS';

interface Measurement {
  label: string;
  characters: number;
  seconds: number;
  digest: GeneratedMeetingDigest;
}

/**
 * `MeetingDigestGenerator` over Anthropic's real API, for the `test:live` specs: the
 * generator as the API builds it, the token as the API reads it, and a note of what every
 * generation took — which is what a time limit and a cap are set from.
 *
 * The token comes from the env files and never from the shell, for the reason
 * `claude-agent.live-spec.ts` gives where it does the same.
 *
 * **The run's tools are the real ones, over stand-ins for what is behind them.** The server
 * is `MeetingTools`' own, made by the real SDK and called by the real model; `TaskService`
 * is `LiveMeetingTasks`, in memory, and a revision of the digest is answered as it is for a
 * meeting that has none — which is every meeting here, there being no database.
 * The run's hooks are `MeetingHooks`' own too, registered as the generator registers them.
 */
export class LiveMeetingDigest {
  private readonly measurements: Measurement[] = [];

  private constructor(
    /** The tasks the runs' tools found and wrote, and every call they made. */
    readonly tasks: LiveMeetingTasks,
    /** Every `update_meeting` the model made, by the meeting it was made for. */
    readonly revisedMeetingIds: ReadonlyArray<string>,
    private readonly testingModule: TestingModule,
    private readonly generator: MeetingDigestGenerator,
    private readonly config: ConfigService,
    private readonly configuredToken: string | undefined,
  ) {}

  static async start(): Promise<LiveMeetingDigest> {
    delete process.env[AUTH_TOKEN_VARIABLE];

    const tasks = new LiveMeetingTasks();
    const revisedMeetingIds: string[] = [];
    const commands = {
      execute: ({ meetingId }: { meetingId: string }): Promise<MeetingDigestRevisionOutcome> => {
        revisedMeetingIds.push(meetingId);

        return Promise.resolve(MeetingDigestRevisionOutcome.NO_DIGEST);
      },
    };
    const testingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ENV_FILE_PATHS }),
        ClaudeAgentModule,
        MeetingToolsModule,
      ],
      // The generator and the two modules it draws on, not `MeetingDigestsModule`: that one
      // has a controller, a guard, and a repository, which want the rest of the API's
      // configuration and a database, and none of which a generation touches.
      providers: [MeetingDigestGenerator],
    })
      .overrideProvider(TaskService)
      .useValue(tasks)
      .overrideProvider(CommandBus)
      .useValue(commands)
      .compile();
    const config = testingModule.get(ConfigService);

    // Whatever an env file says, read here as text: every run has the default budget
    // unless its spec gives it another.
    config.set(MAX_TOOL_CALLS_VARIABLE, DEFAULT_MEETING_DIGEST_MAX_TOOL_CALLS);

    return new LiveMeetingDigest(
      tasks,
      revisedMeetingIds,
      testingModule,
      testingModule.get(MeetingDigestGenerator),
      config,
      config.get<string>(AUTH_TOKEN_VARIABLE),
    );
  }

  /**
   * One generation, measured. `label` is the row it prints as when the suite ends.
   *
   * `meetingId` is the meeting whose tools the run is handed: a new one unless a spec passes
   * the same id twice, which is how it generates again over the tasks the first run left.
   */
  async generateFrom(
    label: string,
    transcripts: string[],
    meetingId: string = crypto.randomUUID(),
  ): Promise<GeneratedMeetingDigest> {
    const characters = transcripts.reduce((total, transcript) => total + transcript.length, 0);
    const startedAt = performance.now();
    const digest = await this.generator.generate(
      meetingId,
      transcripts,
      new AbortController().signal,
    );

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

  /** The budget of tool calls for the generations that follow, until it is restored. */
  limitToolCalls(maxToolCalls: number): void {
    this.config.set(MAX_TOOL_CALLS_VARIABLE, maxToolCalls);
  }

  /**
   * Back to the default, as a number. **Not `undefined`**: `ConfigService.set` also writes
   * the value to `process.env` as text, where a setting taken away reads back as the word
   * "undefined" — and there is no env contract in this module to turn text into a number.
   */
  restoreToolCalls(): void {
    this.config.set(MAX_TOOL_CALLS_VARIABLE, DEFAULT_MEETING_DIGEST_MAX_TOOL_CALLS);
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
