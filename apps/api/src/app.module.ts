import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ConnectionDrainService } from './common/shutdown/connection-drain.service';
import { ENV_FILE_PATHS } from './config/env-values';
import { validate } from './config/env.validation';
import { AuthModule } from './modules/auth/auth.module';
import { ClaudeAgentModule } from './modules/claude-agent/claude-agent.module';
import { HealthModule } from './modules/health/health.module';
import { MeetingFilesModule } from './modules/meeting-files/meeting-files.module';
import { MeetingsModule } from './modules/meetings/meetings.module';
import { PrismaModule } from './modules/prisma/prisma.module';
import { UserModule } from './modules/user/user.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate,
      envFilePath: ENV_FILE_PATHS,
    }),
    PrismaModule,
    HealthModule,
    UserModule,
    AuthModule,
    MeetingsModule,
    MeetingFilesModule,
    ClaudeAgentModule,
  ],
  // Here and not in a feature module: the root module's destroy hook is the first one Nest
  // runs, and letting go of kept-alive connections has to begin before anything else stops.
  providers: [ConnectionDrainService],
})
export class AppModule {}
