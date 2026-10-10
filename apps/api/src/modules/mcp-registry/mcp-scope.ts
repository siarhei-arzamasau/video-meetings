import type { Logger } from '@nestjs/common';

import { describeError } from '../../common/error-message';

/**
 * Who an MCP server is answering: the user its client was let in as. What a tool or a
 * resource is handed for a rule about them that is finer than "may read the meeting" — as
 * the tasks domain's is, which answers each user with their own tasks.
 */
export interface McpRequester {
  userId: string;
}

/** Who was let in, or the sentence they are refused with. */
export type McpAdmission = { requester: McpRequester } | { refusal: string };

/**
 * What a server has every registrar register for: the one meeting it serves, and the gate
 * in front of it.
 *
 * **The meeting is the server's, never an argument of a tool**, so nothing a model sends
 * can turn a search of one meeting into a search of every meeting, or write there.
 * **`admit` is asked before every call and every read**, as a route checks every request:
 * whoever builds the server decides who may use it, each time.
 */
export interface McpScope {
  meetingId: string;
  admit: () => Promise<McpAdmission>;
}

/** One sentence for a gate that failed, whatever was asked for: the cause is the log's. */
export const ACCESS_NOT_CHECKED = 'Access could not be checked.';

/**
 * The gate's answer, for a tool or a resource to act on. **Let in only by an answer that
 * names who the requester is, never by one that merely carries no refusal** — read as what
 * it holds, not as what its type promises, since every server writes a gate of its own.
 * And a gate that threw let nobody in: an error there must not leave anything open.
 */
export async function admissionOf(scope: McpScope, logger: Logger): Promise<McpAdmission> {
  try {
    const admission: Partial<{ requester: Partial<McpRequester>; refusal: string }> =
      await scope.admit();
    const userId = admission.requester?.userId;

    return typeof userId === 'string'
      ? { requester: { userId } }
      : { refusal: admission.refusal ?? ACCESS_NOT_CHECKED };
  } catch (error) {
    logger.error('Access could not be checked', describeError(error));

    return { refusal: ACCESS_NOT_CHECKED };
  }
}
