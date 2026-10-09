import { Module } from '@nestjs/common';

import { ClaudeAgentSdkLoader } from './services/claude-agent-sdk.loader';
import { ClaudeAgentToolkitLoader } from './services/claude-agent-toolkit.loader';
import { ClaudeAgentService } from './services/claude-agent.service';

/**
 * Claude, for any feature that needs it. No controller and no commands: sending a prompt
 * changes no state here, and nothing reaches Claude over HTTP until a feature decides what
 * may. A module that wants it imports this one and injects `ClaudeAgentService`.
 */
@Module({
  providers: [ClaudeAgentService, ClaudeAgentSdkLoader, ClaudeAgentToolkitLoader],
  // The toolkit is what a feature describes tools of its own with — `meeting-tools` does.
  // The loader that sends a prompt stays inside: a feature that wants an answer injects
  // the service.
  exports: [ClaudeAgentService, ClaudeAgentToolkitLoader],
})
export class ClaudeAgentModule {}
