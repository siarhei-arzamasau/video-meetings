'use client';

import {
  Alert,
  Button,
  Card,
  Description,
  FieldError,
  Form,
  InputGroup,
  Label,
  Spinner,
  TextField,
  buttonVariants,
} from '@heroui/react';
import { MIN_PASSWORD_LENGTH } from '@repo/shared';
import Link from 'next/link';
import { useMemo, useState, type FormEvent } from 'react';

import { ApiError, register } from '@/lib/api-client';
import { storeAccessToken } from '@/lib/auth-token';
import { normaliseEmail, validateEmail, validatePassword } from '@/lib/credentials';

/** The field a failure belongs on, or `null` when it belongs to the form as a whole. */
type FailedField = 'email' | null;

type Submission =
  | { state: 'idle' }
  | { state: 'submitting' }
  | { state: 'failed'; message: string; field: FailedField }
  | { state: 'created'; email: string };

/**
 * Stable identity matters. React Aria resets its "the user has since edited this field" flag
 * whenever the `validationErrors` object is not the one it saw last render, so a fresh `{}`
 * literal per render would pin a server error open forever — the field could never clear, and
 * native validation would refuse to submit the corrected value.
 */
const NO_FIELD_ERRORS: Record<string, string> = {};

/** `.card` ships 4 units of padding, which suits a dense list card and looks cramped as the
 *  only thing on screen. Utilities win the cascade over it. */
const CARD_CLASS = 'w-full gap-6 p-8';

/**
 * The card owns the heading as well as the form, because the two have to change together:
 * "Create your account" over a confirmation that the account already exists is a card arguing
 * with itself.
 */
export function RegisterCard() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isPasswordVisible, setPasswordVisible] = useState(false);
  const [submission, setSubmission] = useState<Submission>({ state: 'idle' });

  const fieldErrors = useMemo(
    () =>
      submission.state === 'failed' && submission.field !== null
        ? { [submission.field]: submission.message }
        : NO_FIELD_ERRORS,
    [submission],
  );

  if (submission.state === 'created') {
    return (
      <Card className={CARD_CLASS}>
        <AccountCreated email={submission.email} />
      </Card>
    );
  }

  const isSubmitting = submission.state === 'submitting';
  const formError = submission.state === 'failed' && submission.field === null ? submission : null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Reaching here means both fields passed: the form is natively validated, so the browser
    // blocks submission while either `validate` below is returning a message.
    const address = normaliseEmail(email);

    setSubmission({ state: 'submitting' });

    try {
      const { accessToken } = await register({ email: address, password });

      storeAccessToken(accessToken);
      setSubmission({ state: 'created', email: address });
    } catch (error) {
      setSubmission({ state: 'failed', ...describeFailure(error) });
    }
  }

  return (
    <Card className={CARD_CLASS}>
      <Card.Header className="gap-1.5">
        <Card.Title className="text-2xl leading-8">Create your account</Card.Title>
        <Card.Description>
          Your email and a password are all it takes. No credit card, no meeting-room hardware.
        </Card.Description>
      </Card.Header>

      <Form
        className="flex flex-col gap-5"
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
              <Alert.Title>We could not create your account</Alert.Title>
              <Alert.Description>{formError.message}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}

        <TextField
          name="email"
          type="email"
          value={email}
          onChange={setEmail}
          isRequired
          isDisabled={isSubmitting}
          autoComplete="email"
          validate={(value) => validateEmail(value) ?? true}
          fullWidth
        >
          <Label>Email address</Label>
          <InputGroup fullWidth>
            <InputGroup.Prefix>
              <MailIcon />
            </InputGroup.Prefix>
            <InputGroup.Input placeholder="you@example.com" />
          </InputGroup>
          <FieldError />
        </TextField>

        <TextField
          name="password"
          type={isPasswordVisible ? 'text' : 'password'}
          value={password}
          onChange={setPassword}
          isRequired
          isDisabled={isSubmitting}
          autoComplete="new-password"
          validate={(value) => validatePassword(value) ?? true}
          fullWidth
        >
          <Label>Password</Label>
          <InputGroup fullWidth>
            <InputGroup.Prefix>
              <LockIcon />
            </InputGroup.Prefix>
            <InputGroup.Input placeholder="••••••••" />
            <InputGroup.Suffix>
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                // Not a form control: excluded from the submitted values, and labelled by state
                // because the icon alone does not say which way it is about to go.
                aria-label={isPasswordVisible ? 'Hide password' : 'Show password'}
                onPress={() => {
                  setPasswordVisible((visible) => !visible);
                }}
              >
                {isPasswordVisible ? <EyeOffIcon /> : <EyeIcon />}
              </Button>
            </InputGroup.Suffix>
          </InputGroup>
          <Description>
            At least {MIN_PASSWORD_LENGTH} characters. A passphrase beats a short, clever one.
          </Description>
          <FieldError />
        </TextField>

        <Button type="submit" variant="primary" size="lg" fullWidth isDisabled={isSubmitting}>
          {isSubmitting ? (
            <>
              <Spinner size="sm" />
              Creating your account…
            </>
          ) : (
            'Create account'
          )}
        </Button>

        <p className="text-muted text-center text-xs">
          By creating an account you agree to be a considerate meeting host.
        </p>
      </Form>
    </Card>
  );
}

/**
 * Turns a thrown value into something to show, and decides where.
 *
 * A taken address is the email field's problem — putting it in a banner leaves the user
 * hunting for which of two fields to change. Everything else belongs to the form.
 */
function describeFailure(error: unknown): { message: string; field: FailedField } {
  if (error instanceof ApiError) {
    return { message: error.message, field: error.status === 409 ? 'email' : null };
  }

  // `fetch` rejects rather than resolving when the request never reached the API at all.
  return {
    message: 'We could not reach the server. Check your connection and try again.',
    field: null,
  };
}

function AccountCreated({ email }: { email: string }) {
  return (
    <div className="flex flex-col items-center gap-4 py-4 text-center">
      <span className="bg-success/15 text-success flex size-14 items-center justify-center rounded-full">
        <CheckIcon />
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">You're all set</h2>
        <p className="text-muted text-sm">
          Your account for <span className="text-foreground font-medium">{email}</span> is ready,
          and you are signed in.
        </p>
      </div>
      <Link href="/" className={buttonVariants({ variant: 'primary', fullWidth: true })}>
        Continue
      </Link>
    </div>
  );
}

/* Icons are inline so the page adds no dependency and no network request for a 16px glyph. */

const strokeProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function MailIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4" {...strokeProps}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4" {...strokeProps}>
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 1 1 8 0v3" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4" {...strokeProps}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4" {...strokeProps}>
      <path d="M9.9 5.8A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.2 4M6.2 7.6A17 17 0 0 0 2.5 12S6 18.5 12 18.5a9.4 9.4 0 0 0 4-.86" />
      <path d="M10 10a2.8 2.8 0 0 0 4 4M3 3l18 18" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4" {...strokeProps}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5M12 16h.01" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-7" {...strokeProps}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}
