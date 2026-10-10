import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Injectable, Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { McpRegistryModule } from './mcp-registry.module';
import type { McpScope } from './mcp-scope';
import type { McpToolRegistrar } from './mcp-tool-registrar';
import { McpToolRegistry } from './mcp-tool-registry';

const SCOPE: McpScope = {
  meetingId: '44444444-4444-4444-8444-444444444444',
  admit: () => Promise.resolve({ refusal: 'Nobody is asked in.' }),
};

const newServer = (): McpServer => new McpServer({ name: 'spec', version: '0.0.0' });

class FirstTools implements McpToolRegistrar {
  register = jest.fn();
}

class SecondTools implements McpToolRegistrar {
  register = jest.fn();
}

describe('McpToolRegistry', () => {
  it('has every registrar register on the server, for the scope, in the order they were added', () => {
    const registry = new McpToolRegistry();
    const [first, second] = [new FirstTools(), new SecondTools()];
    const server = newServer();
    registry.add(first);
    registry.add(second);

    registry.registerAll(server, SCOPE);

    expect(first.register).toHaveBeenCalledWith(server, SCOPE);
    expect(second.register).toHaveBeenCalledWith(server, SCOPE);
    expect(first.register.mock.invocationCallOrder[0]).toBeLessThan(
      second.register.mock.invocationCallOrder[0] ?? 0,
    );
    expect(registry.names()).toEqual(['FirstTools', 'SecondTools']);
  });

  it('registers again on every server it is asked for, a request at a time', () => {
    const registry = new McpToolRegistry();
    const tools = new FirstTools();
    registry.add(tools);

    registry.registerAll(newServer(), SCOPE);
    registry.registerAll(newServer(), SCOPE);

    expect(tools.register).toHaveBeenCalledTimes(2);
  });

  it('counts a registrar added twice as one', () => {
    const registry = new McpToolRegistry();
    const tools = new FirstTools();
    registry.add(tools);
    registry.add(tools);

    registry.registerAll(newServer(), SCOPE);

    expect(tools.register).toHaveBeenCalledTimes(1);
  });

  it('refuses a registrar once a server has been built, and names it', () => {
    const registry = new McpToolRegistry();
    registry.add(new FirstTools());
    registry.registerAll(newServer(), SCOPE);

    expect(() => registry.add(new SecondTools())).toThrow(
      /SecondTools was added to the MCP tool registry after a server had been built/,
    );
  });
});

/**
 * The order the registry depends on, held against Nest itself: a domain adds its registrar
 * in `onModuleInit`, a consumer builds a server in its own, and which runs first is decided
 * by the import tree — the deepest module first.
 */
describe('McpToolRegistry, across modules as Nest starts them', () => {
  @Injectable()
  class DomainTools implements McpToolRegistrar, OnModuleInit {
    constructor(private readonly registry: McpToolRegistry) {}

    onModuleInit(): void {
      this.registry.add(this);
    }

    register(): void {
      // What it would register is not the point here: that it is there in time is.
    }
  }

  @Module({ imports: [McpRegistryModule], providers: [DomainTools] })
  class DomainModule {}

  /** A module that builds a server as it starts, as `McpModule` does. */
  @Injectable()
  class ServerBuilder implements OnModuleInit {
    seen: string[] = [];

    constructor(private readonly registry: McpToolRegistry) {}

    onModuleInit(): void {
      this.registry.registerAll(newServer(), SCOPE);
      this.seen = this.registry.names();
    }
  }

  it('has the registrar ready for a consumer that imports its module', async () => {
    @Module({ imports: [McpRegistryModule, DomainModule], providers: [ServerBuilder] })
    class ConsumerModule {}

    // Listed first on purpose: importing is what orders the two, not where each is written.
    const moduleRef = await Test.createTestingModule({
      imports: [ConsumerModule, DomainModule],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get(ServerBuilder).seen).toEqual(['DomainTools']);
  });

  it('refuses to start, naming the registrar, when the consumer merely sits beside its module', async () => {
    @Module({ imports: [McpRegistryModule], providers: [ServerBuilder] })
    class ConsumerModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [ConsumerModule, DomainModule],
    }).compile();

    // At one depth the order is the order written, so the server was built first. Left
    // quiet, that would be a server with a domain's tools missing; it is an error instead.
    await expect(moduleRef.init()).rejects.toThrow(
      /DomainTools was added to the MCP tool registry after a server had been built/,
    );
  });
});
