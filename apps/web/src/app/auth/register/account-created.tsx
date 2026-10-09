import { ButtonLink } from '@/components/button-link';
import { CheckIcon } from '@/components/icons';

/** What the registration card shows in place of its form once the account exists. */
export function AccountCreated({ email }: { email: string }) {
  return (
    <div className="flex flex-col items-center gap-4 py-4 text-center">
      <span className="bg-success/15 text-success flex size-14 items-center justify-center rounded-full">
        <CheckIcon />
      </span>
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">You're all set</h1>
        <p className="text-muted text-sm">
          Your account for <span className="text-foreground font-medium">{email}</span> is ready,
          and you are signed in.
        </p>
      </div>
      <ButtonLink href="/" fullWidth>
        Continue
      </ButtonLink>
    </div>
  );
}
