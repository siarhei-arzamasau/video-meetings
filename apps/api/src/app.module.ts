import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validate } from './config/env.validation';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { MeetingsModule } from './modules/meetings/meetings.module';
import { PrismaModule } from './modules/prisma/prisma.module';
import { UserModule } from './modules/user/user.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate,
      envFilePath: ['.env.local', '.env'],
    }),
    PrismaModule,
    HealthModule,
    UserModule,
    AuthModule,
    MeetingsModule,
  ],
})
export class AppModule {}
