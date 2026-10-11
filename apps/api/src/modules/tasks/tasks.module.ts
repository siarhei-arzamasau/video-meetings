import { Module } from '@nestjs/common';

import { McpRegistryModule } from '../mcp-registry/mcp-registry.module';
import { TaskTools } from './mcp/task-tools';
import { TaskService } from './services/task.service';

@Module({
  // `McpRegistryModule` is where `TaskTools` says what this domain offers over MCP. It adds
  // itself as this module starts, so a server offers the task tools wherever this module
  // was loaded and initialised before it — which is why a module that builds a server
  // imports this one rather than merely sitting beside it.
  imports: [McpRegistryModule],
  // No controller: no REST route reaches a task. The service is exported for what hands it
  // to an agent itself: `meeting-tools`, inside a digest's run. `TaskTools` is not exported:
  // nothing injects it, and a server reaches it through the registry.
  providers: [TaskService, TaskTools],
  exports: [TaskService],
})
export class TasksModule {}
