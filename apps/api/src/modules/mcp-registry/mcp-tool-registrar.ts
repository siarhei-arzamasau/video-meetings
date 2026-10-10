import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { McpScope } from './mcp-scope';

/**
 * What a domain hands the registry: a provider of its own that knows how to put that
 * domain's tools — and resources and prompts, where it has any — on an `McpServer`.
 *
 * **It registers for a scope and decides nothing about who may call**: the scope's gate is
 * the server's, and the registrar's part is to ask it before every call and every read
 * (`admissionOf`). **It may be called many times**, once per server, and a server may live
 * for one request: whatever it registers must hold no state of the server's between calls.
 */
export interface McpToolRegistrar {
  register(server: McpServer, scope: McpScope): void;
}
