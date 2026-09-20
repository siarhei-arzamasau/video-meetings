'use client';

import {
  Alert,
  Button,
  Card,
  Description,
  FieldError,
  Form,
  Input,
  Label,
  Skeleton,
  Spinner,
  TextField,
} from '@heroui/react';
import { MAX_DISPLAY_NAME_LENGTH, type User } from '@repo/shared';
import { useMemo, useState, type FormEvent } from 'react';

import { CheckIcon, WarningIcon } from '@/components/icons';
import { ApiError, updateDisplayName } from '@/lib/api-client';
import { validateDisplayName } from '@/lib/user';

/** The field a failure belongs on, or `null` when it belongs to the section as a whole. */
type FailedField = 'displayName' | null;

type Save =
  | { state: 'idle' }
  | { state: 'saving' }
  | { state: 'saved' }
  | { state: 'failed'; message: string; field: FailedField };

/**
 * Stable identity matters — the same trap `register-card.tsx` documents. React Aria resets its
 * "the user has since edited this field" flag whenever the `validationErrors` object is not
 * the one it saw last render, so a fresh `{}` literal per render would pin a server error open
 * for ever: the field could never clear, and native validation would then refuse to submit the
 * corrected value.
 */
const NO_FIELD_ERRORS: Record<string, string> = {};

/**
 * The display name, and nothing else this phase touches.
 *
 * One file per section, because the page is where phases 4 and 6 add password and avatar: the
 * page owns the gate and decides which sections exist, and each section owns its request, its
 * state, and the skeleton that stands in for its own shape.
 *
 * **Nothing is saved until Save changes is pressed.** There is no autosave, no draft kept
 * anywhere, and no blur handler that writes — so leaving the page with an edited field leaves
 * the stored name exactly as it was, and coming back shows that stored name rather than what
 * was typed. The state below is local to this component for that reason: it dies with the
 * route, which is what "leaving saves nothing" means in practice.
 */
export function DisplayNameSection({
  user,
  token,
  onSaved,
  onUnauthorized,
}: {
  user: User;
  token: string;
  onSaved: (user: User) => void;
  onUnauthorized: () => void;
}) {
  // Seeded from the loaded user, so the field starts on the stored name and the user edits
  // what they have. This component is only mounted once the gate is `ready`, so there is no
  // window in which that seed would be an empty string.
  const [displayName, setDisplayName] = useState(user.displayName);
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
  // Nothing to send when the trimmed value is already the stored one — the API trims too, so
  // those two names are the same name, and the request would change nothing.
  const isUnchanged = displayName.trim() === user.displayName;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Reaching here means the field passed: the form is natively validated, so the browser
    // blocks submission while `validate` is returning a message.
    setSave({ state: 'saving' });

    try {
      // Sent as typed; the API trims and answers with the trimmed value, which is what
      // replaces the signed-in user — so the header and the profile show what was stored
      // rather than what was keyed.
      const updated = await updateDisplayName(token, displayName);

      onSaved(updated);
      setSave({ state: 'saved' });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        // The token went bad between the gate's load and this request. Same answer as the
        // gate's: clear it and go to sign-in.
        onUnauthorized();

        return;
      }

      setSave({ state: 'failed', ...describeSaveFailure(error) });
    }
  }

  return (
    <Card className="p-6">
      <Card.Header className="gap-1.5 p-0">
        {/* An `h2`, not the `h3` `Card.Title` defaults to: this page's only heading above it is
            the `h1`, so a section that stayed an `h3` would skip a level — and this page is
            where phases 4 and 6 add sibling sections, each with a heading of its own. */}
        <Card.Title
          className="text-lg"
          render={({ children, ...props }) => <h2 {...props}>{children}</h2>}
        >
          Display name
        </Card.Title>
        <Card.Description>
          What everyone you meet with sees. Changing it does not change the address you sign in
          with.
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
              <Alert.Title>We could not save your display name</Alert.Title>
              <Alert.Description>{formError.message}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}

        {save.state === 'saved' && (
          // An `output` — a polite live region, and the element that already means one, which
          // is the house spelling of `role="status"` here. Polite rather than the `alert` above
          // it: this is the answer to something the reader just did, so it should be announced
          // without interrupting them.
          <output className="block w-full">
            <Alert status="success">
              <Alert.Indicator>
                <CheckIcon />
              </Alert.Indicator>
              <Alert.Content>
                <Alert.Description>Your display name is saved.</Alert.Description>
              </Alert.Content>
            </Alert>
          </output>
        )}

        {/* No `isRequired`: the browser's own "please fill out this field" would replace the
            one sentence `@repo/shared` gives every rejection, and blank is already one of the
            cases `validateDisplayName` covers. */}
        <TextField
          name="displayName"
          value={displayName}
          onChange={(value) => {
            setDisplayName(value);
            // The confirmation describes the stored name; the moment the field says something
            // else, it is describing something that is no longer on screen.
            setSave((current) => (current.state === 'saved' ? { state: 'idle' } : current));
          }}
          isDisabled={isSaving}
          autoComplete="name"
          validate={(value) => validateDisplayName(value) ?? true}
          fullWidth
        >
          <Label>Display name</Label>
          <Input placeholder="Ada Lovelace" />
          {/* No `maxLength` on the input: it would silently truncate a pasted name rather than
              say what is wrong with it. */}
          <Description>Up to {MAX_DISPLAY_NAME_LENGTH} characters.</Description>
          <FieldError />
        </TextField>

        <Button type="submit" variant="primary" isDisabled={isSaving || isUnchanged}>
          {isSaving ? (
            <>
              <Spinner size="sm" />
              Saving…
            </>
          ) : (
            'Save changes'
          )}
        </Button>
      </Form>
    </Card>
  );
}

/**
 * Turns a thrown value into something to show, and decides where.
 *
 * A 400 is the field's problem — it is the API applying the same bound the field just checked,
 * and its message is the very constant the field renders — so it belongs under the input the
 * user has to change. Everything else belongs to the section: a 500 or an unreachable API says
 * nothing about the name that was typed.
 */
function describeSaveFailure(error: unknown): { message: string; field: FailedField } {
  if (error instanceof ApiError) {
    return { message: error.message, field: error.status === 400 ? 'displayName' : null };
  }

  // `fetch` rejects rather than resolving when the request never reached the API at all.
  return {
    message: 'We could not reach the server. Check your connection and try again.',
    field: null,
  };
}

/**
 * This section's own frame, so `ready` fills it in rather than laying the page out from
 * scratch. It lives here rather than on the page because it is this section's shape: the page
 * only decides when to show it, and a section added later brings its own.
 */
export function DisplayNameSkeleton() {
  return (
    <Card className="gap-6 p-6" aria-hidden="true">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-40 rounded" />
        <Skeleton className="h-4 w-72 max-w-full rounded" />
      </div>

      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-28 rounded" />
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-4 w-36 rounded" />
      </div>

      <Skeleton className="h-10 w-32 rounded-lg" />
    </Card>
  );
}
