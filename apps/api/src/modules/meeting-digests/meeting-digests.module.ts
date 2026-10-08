import { Module } from '@nestjs/common';

import { ClaudeAgentModule } from '../claude-agent/claude-agent.module';
import { MeetingDigestGenerator } from './services/meeting-digest-generator';

/**
 * The digest of a meeting — summary, action items, decisions — written by Claude from the
 * transcripts of its recordings. So far it holds the one part that needs no table: turning
 * transcripts into a validated digest. No route reaches it yet and nothing calls it.
 *
 * It reaches Claude through `ClaudeAgentModule` and nothing else of another module: when it
 * comes to need transcripts, members, and names, it asks for them over the buses.
 */
@Module({
  imports: [ClaudeAgentModule],
  providers: [MeetingDigestGenerator],
})
export class MeetingDigestsModule {}
