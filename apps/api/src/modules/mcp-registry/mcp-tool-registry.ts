import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Injectable } from '@nestjs/common';

import type { McpScope } from './mcp-scope';
import type { McpToolRegistrar } from './mcp-tool-registrar';

/**
 * Where each domain says what it offers over MCP, so that no file lists them all: a
 * domain's registrar adds itself in its own `onModuleInit`, and a server registers whatever
 * is here. Adding a domain's tools is that domain's module and nothing else — not an edit
 * to the MCP module, and not a second list somewhere to forget.
 *
 * **What a server offers is therefore decided by its module's imports.** A registrar
 * exists only where its module was loaded, so a second server in a process of its own
 * would offer the domains its own module tree brings in, and no others.
 *
 * **Order is the one thing to get right, and the registry refuses to get it wrong
 * quietly.** Nest runs `onModuleInit` module by module, the deepest in the import tree
 * first. A module that builds a server in its own `onModuleInit` must therefore *import*
 * every domain module whose registrar it expects — imported, the domain is deeper and is
 * ready first; merely listed beside it in the root module, the two are at one depth and
 * the order is whichever was written first. So the first `registerAll` closes the registry:
 * a registrar that arrives after a server has been built is an error at boot that names it,
 * not a tool that is silently missing from every server.
 */
@Injectable()
export class McpToolRegistry {
  private readonly registrars: McpToolRegistrar[] = [];
  private closed = false;

  /** Called by a registrar, in its `onModuleInit`. Adding one twice is adding it once. */
  add(registrar: McpToolRegistrar): void {
    if (this.closed) {
      throw new Error(
        `${registrar.constructor.name} was added to the MCP tool registry after a server had been built from it. ` +
          'Import its module from the module that builds the server, so that it is initialised first.',
      );
    }

    if (!this.registrars.includes(registrar)) {
      this.registrars.push(registrar);
    }
  }

  /** Has every registrar register on `server`, for `scope` — and closes the registry. */
  registerAll(server: McpServer, scope: McpScope): void {
    this.closed = true;

    for (const registrar of this.registrars) {
      registrar.register(server, scope);
    }
  }

  /** The registrars by class name, in the order they were added: for a log line. */
  names(): string[] {
    return this.registrars.map((registrar) => registrar.constructor.name);
  }
}
