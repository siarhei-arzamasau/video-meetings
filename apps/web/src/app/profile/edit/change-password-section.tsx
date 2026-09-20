'use client';

import { Alert, Button, Card, Form, Skeleton, Spinner } from '@heroui/react';
import { MIN_PASSWORD_LENGTH } from '@repo/shared';
import { useMemo, useState, type FormEvent } from 'react';

import { CheckIcon, InfoIcon, WarningIcon } from '@/components/icons';
import { changePassword } from '@/lib/api-client';
import {
  validateLoginPassword,
  validateNewPassword,
  validatePasswordConfirmation,
} from '@/lib/credentials';

import { describeSaveFailure, isExpiredToken, type FailedField } from './change-password-failure';
import { PasswordField } from './password-field';

type Save =
  | { state: 'idle' }
  | { state: 'saving' }
  | { state: 'saved' }
  | { state: 'failed'; message: string; field: FailedField };

/**
 * Stable identity, for the reason `display-name-section.tsx` and `register-card.tsx` both
 * document: React Aria resets its "the user has since edited this field" flag whenever the
 * `validationErrors` object is not the one it saw last render, so a fresh `{}` per render
 * would pin a server error open for ever.
 */
const NO_FIELD_ERRORS: Record<string, string> = {};

const EMPTY = { currentPassword: '', newPassword: '', confirmation: '' };

/**
 * Rotating the password, from the edit page.
 *
 * Three fields, and the third never leaves the browser: the API has nothing to compare a
 * confirmation against that this form did not already have, so a mismatch is caught here and
 * nowhere else.
 *
 * The section holds no user — unlike the display name, a password change has nothing to put
 * back into the signed-in user, and the token in hand keeps working because it carries no
 * password. That is also the thing the note below the fields exists to say.
 *
 * Nothing is kept after a successful change: the three fields are cleared, because what is in
 * them at that point is the password just replaced and the one just chosen, and neither should
 * sit in a form on a screen somebody else may walk up to.
 */
export function ChangePasswordSection({
  token,
  onUnauthorized,
}: {
  token: string;
  onUnauthorized: () => void;
}) {
  const [fields, setFields] = useState(EMPTY);
  const [isRevealed, setRevealed] = useState(false);
  const [save, setSave] = useState<Save>({ state: 'idle' });

  const fieldErrors = useMemo(
    () =>
      save.state === 'failed' && save.field !== null
        ? { [save.field]: save.message }
        : NO_FIELD_ERRORS,
    [save],
  );

  const isSaving = save.state === 'saving';
  const formError = save.state === 'failed' && save.field === null ? save : null;

  /** Edits one field, and retires a confirmation that is about to stop being true. */
  function edit(field: keyof typeof fields, value: string) {
    setFields((current) => ({ ...current, [field]: value }));
    setSave((current) => (current.state === 'saved' ? { state: 'idle' } : current));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Reaching here means all three fields passed: the form is natively validated, so the
    // browser blocks submission while any `validate` below is returning a message. The
    // confirmation is therefore known to match, and is not sent.
    setSave({ state: 'saving' });

    try {
      await changePassword(token, fields.currentPassword, fields.newPassword);

      setFields(EMPTY);
      setSave({ state: 'saved' });
    } catch (error) {
      if (isExpiredToken(error)) {
        onUnauthorized();

        return;
      }

      setSave({ state: 'failed', ...describeSaveFailure(error) });
    }
  }

  return (
    <Card className="p-6">
      <Card.Header className="gap-1.5 p-0">
        {/* An `h2`, as every section on this page is: the only heading above them is the `h1`. */}
        <Card.Title
          className="text-lg"
          render={({ children, ...props }) => <h2 {...props}>{children}</h2>}
        >
          Password
        </Card.Title>
        <Card.Description>
          Enter the password you sign in with today, then the one you want instead.
        </Card.Description>
      </Card.Header>

      <Form
        className="mt-6 flex flex-col items-start gap-5"
        validationErrors={fieldErrors}
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
      >
        {formError !== null && (
          <Alert status="danger" role="alert">
            <Alert.Indicator>
              <WarningIcon />
            </Alert.Indicator>
            <Alert.Content>
              <Alert.Title>We could not change your password</Alert.Title>
              <Alert.Description>{formError.message}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}

        {save.state === 'saved' && (
          // Polite rather than the `alert` above it: this answers something the reader just
          // did, so it should be announced without interrupting them.
          <output className="block w-full">
            <Alert status="success">
              <Alert.Indicator>
                <CheckIcon />
              </Alert.Indicator>
              <Alert.Content>
                <Alert.Description>
                  Your password is changed. Use the new one next time you sign in.
                </Alert.Description>
              </Alert.Content>
            </Alert>
          </output>
        )}

        <PasswordField
          name="currentPassword"
          label="Current password"
          autoComplete="current-password"
          value={fields.currentPassword}
          isRevealed={isRevealed}
          isDisabled={isSaving}
          // The sign-in rule, not the registration one: this field holds whatever was accepted
          // when the account was made, and applying today's minimum to it would refuse an old
          // password on the very form that exists to replace it.
          validate={(value) => validateLoginPassword(value) ?? true}
          onChange={(value) => {
            edit('currentPassword', value);
          }}
          onToggleReveal={() => {
            setRevealed((revealed) => !revealed);
          }}
        />

        <PasswordField
          name="newPassword"
          label="New password"
          autoComplete="new-password"
          value={fields.newPassword}
          isRevealed={isRevealed}
          isDisabled={isSaving}
          validate={(value) => validateNewPassword(value, fields.currentPassword) ?? true}
          description={`At least ${String(MIN_PASSWORD_LENGTH)} characters, and not the one you have now.`}
          onChange={(value) => {
            edit('newPassword', value);
          }}
        />

        <PasswordField
          name="confirmation"
          label="Confirm new password"
          autoComplete="new-password"
          value={fields.confirmation}
          isRevealed={isRevealed}
          isDisabled={isSaving}
          validate={(value) => validatePasswordConfirmation(value, fields.newPassword) ?? true}
          onChange={(value) => {
            edit('confirmation', value);
          }}
        />

        {/* Next to the form, not in a tooltip or a help page: it is the one consequence of this
            change the user cannot see for themselves, and stating it is the mitigation
            `docs/specs/2026-09-20-user-profile-prd.md` agreed on for a token that cannot be
            revoked. */}
        <Alert status="default">
          <Alert.Indicator>
            <InfoIcon />
          </Alert.Indicator>
          <Alert.Content>
            <Alert.Description>
              Changing your password here does not sign out your other devices. They stay signed in
              until their session expires on its own.
            </Alert.Description>
          </Alert.Content>
        </Alert>

        <Button type="submit" variant="primary" isDisabled={isSaving}>
          {isSaving ? (
            <>
              <Spinner size="sm" />
              Changing…
            </>
          ) : (
            'Change password'
          )}
        </Button>
      </Form>
    </Card>
  );
}

/**
 * This section's own frame, so `ready` fills it in rather than laying the page out from
 * scratch. Three fields, a note, and a button — the shape the loaded section has.
 */
export function ChangePasswordSkeleton() {
  return (
    <Card className="gap-6 p-6" aria-hidden="true">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-28 rounded" />
        <Skeleton className="h-4 w-80 max-w-full rounded" />
      </div>

      {['current', 'new', 'confirmation'].map((field) => (
        <div key={field} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-36 rounded" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      ))}

      <Skeleton className="h-16 w-full rounded-lg" />
      <Skeleton className="h-10 w-40 rounded-lg" />
    </Card>
  );
}
