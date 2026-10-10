import { ConsoleLogger } from '@nestjs/common';
import type { LogLevel } from '@nestjs/common';

/**
 * Nest's console logger, with every line on stderr — for a process whose stdout is not its
 * to write on.
 *
 * `ConsoleLogger` sends errors to stderr and everything else to stdout. A process that
 * speaks a protocol over stdout — an MCP server on the stdio transport — would put "Nest
 * application successfully started" in the middle of it, and its client would read that as
 * a frame it cannot parse.
 */
export class StderrLogger extends ConsoleLogger {
  protected override printMessages(
    messages: unknown[],
    context?: string,
    logLevel?: LogLevel,
    _writeStreamType?: 'stdout' | 'stderr',
    errorStack?: unknown,
  ): void {
    super.printMessages(messages, context, logLevel, 'stderr', errorStack);
  }
}
