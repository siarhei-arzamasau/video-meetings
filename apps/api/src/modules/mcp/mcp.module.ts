import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import { AccessTokenModule } from '../auth/access-token.module';
import { McpRegistryModule } from '../mcp-registry/mcp-registry.module';
import { TasksModule } from '../tasks/tasks.module';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';

/**
 * The API's MCP server over HTTP, at `/api/mcp`. Written against the official SDK by hand:
 * a service that builds the server and its transport, and a controller that hands a request
 * to it — no Nest wrapper in between to hide which of the two decides what.
 *
 * `AccessTokenModule` is here for the guard on the route — `McpAuthGuard` verifies a token
 * and reads no user, so it needs the verifying half of `auth` and none of the rest — and
 * `CqrsModule` for the one question asked across a boundary: whether the caller can see the
 * meeting, which `meetings` answers over the bus.
 *
 * **The domain modules are imported for their order, not for a provider.** Nothing here
 * injects anything of `TasksModule`: its registrar reaches the server through
 * `McpToolRegistry`, by adding itself in its own `onModuleInit`. Nest runs that hook for
 * the deepest module in the import tree first, so importing a domain module is what puts
 * its registrar in the registry before `McpService.onModuleInit` reads it. Left out, the
 * two modules sit at one depth under `AppModule`, and which runs first is which was
 * written first. **A domain that grows MCP tools is added to this list** — the one edit
 * outside its own module.
 */
@Module({
  imports: [CqrsModule, AccessTokenModule, McpRegistryModule, TasksModule],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
