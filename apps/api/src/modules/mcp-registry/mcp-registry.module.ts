import { Module } from '@nestjs/common';

import { McpToolRegistry } from './mcp-tool-registry';

/**
 * The registry, in a module of its own so that both sides can import it without importing
 * each other: a domain module, to add its registrar, and a module that builds a server, to
 * read them. It imports nothing, which is what keeps that a tree and not a cycle.
 */
@Module({
  providers: [McpToolRegistry],
  exports: [McpToolRegistry],
})
export class McpRegistryModule {}
