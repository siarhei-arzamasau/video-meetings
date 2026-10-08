import 'reflect-metadata';
// Before `AppModule`, which reads the environment as it is imported.
import './environment';

import { ConsoleLogger, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/configure-app';
import { ClaudeAgentService } from '../../src/modules/claude-agent/services/claude-agent.service';
import { CONTROL_PORT, listenForControl } from './control-server';
import { DigestHolds } from './digest-holds';
import { ScriptedClaudeAgent } from './scripted-claude-agent';

/**
 * The API the web app's browser suite runs against: `src/main.ts`, with the meeting digest
 * switched on and `ScriptedClaudeAgent` bound over `ClaudeAgentService`.
 *
 * It exists because the Claude Agent SDK has no HTTP seam to stand a server behind, as the
 * suite's fake Whisper stands behind `TRANSCRIPTION_API_URL`: the only place to put a
 * stand-in is inside the process, and production code gains no way to ask for one. So the
 * suite boots this file instead of `main.ts` — `start:e2e-web` runs it through `ts-node` —
 * and everything else is the application as it ships: the same module, the same
 * `configureApp`, the same worker.
 */
async function bootstrap(): Promise<void> {
  const holds = new DigestHolds();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ClaudeAgentService)
    .useValue(new ScriptedClaudeAgent(holds))
    .compile();
  // Said, because a testing module is silent unless told otherwise, and this is a server
  // somebody reads the log of when a browser spec times out.
  const app = moduleRef.createNestApplication({ logger: new ConsoleLogger() });

  configureApp(app);
  app.enableShutdownHooks();

  await listenForControl(holds);

  const port = app.get(ConfigService).get<number>('PORT', 3001);
  await app.listen(port, '0.0.0.0');

  Logger.log(
    `Browser-suite API on http://localhost:${port}/api, scripted Claude on ${CONTROL_PORT}`,
    'Bootstrap',
  );
}

void bootstrap();
