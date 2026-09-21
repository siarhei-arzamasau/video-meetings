import { Prisma } from '../../generated/prisma/client';

/**
 * Prisma's "the row you named is not there" (`P2025`), which every handler that updates a row
 * the guard has already loaded has to tell apart from a real failure: it means the account was
 * deleted mid-request, and the answer is the guard's own 401 rather than a 500.
 *
 * Here rather than in each handler because four of them ask the same question. A second code
 * ever meaning the same thing is then one edit, not four that can drift apart.
 */
export function isRecordNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}
