import { Module } from '@nestjs/common';

import { TaskService } from './services/task.service';

@Module({
  // No controller: no route reaches a task. The service is exported for the two modules
  // that hand it to an agent as tools: `meeting-tools`, inside a digest's run, and that
  // module's stdio twin, which serves the search to a client outside this process.
  providers: [TaskService],
  exports: [TaskService],
})
export class TasksModule {}
