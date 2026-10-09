import { Module } from '@nestjs/common';

import { TaskService } from './services/task.service';

@Module({
  // No controller: no route reaches a task. The service is exported for the one module
  // that calls it, `meeting-tools`, which hands its two methods to an agent as tools.
  providers: [TaskService],
  exports: [TaskService],
})
export class TasksModule {}
