'use client';

import {
  Alert,
  Button,
  Card,
  FieldError,
  Form,
  InputGroup,
  Label,
  Spinner,
  TextField,
} from '@heroui/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { ApiError, login } from '@/lib/api-client';
import { storeAccessToken } from '@/lib/auth-token';
import { normaliseEmail, validateEmail, validateLoginPassword } from '@/lib/credentials';

import { CARD_CLASS } from '../card';
import { EyeIcon, EyeOffIcon, LockIcon, MailIcon, WarningIcon } from '../icons';

type Submission =
  | { state: 'idle' }
  | { state: 'submitting' }
  | { state: 'failed'; message: string };

/**
 * There is no `succeeded` state and no confirmation screen: a successful sign-in navigates to
 * the home page, so the only thing this card would render afterwards is a view the user never
 * sees. That is the one structural difference from `RegisterCard`, where the account just
 * created is worth confirming.
 */
export function LoginCard() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isPasswordVisible, setPasswordVisible] = useState(false);
  const [submission, setSubmission] = useState<Submission>({ state: 'idle' });

  const isSubmitting = submission.state === 'submitting';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Reaching here means both fields passed: the form is natively validated, so the browser
    // blocks submission while either `validate` below is returning a message.
    setSubmission({ state: 'submitting' });

    try {
      const { accessToken } = await login({ email: normaliseEmail(email), password });

      storeAccessToken(accessToken);

      // `replace`, not `push`: the back button should not return a signed-in user to the form
      // they just completed.
      router.replace('/');

      // Deliberately not returning to `idle`. This component stays mounted while Next
      // navigates, and re-enabling the button in that window would let a second sign-in
      // through on a double click.
    } catch (error) {
      setSubmission({ state: 'failed', message: describeFailure(error) });
    }
  }

  return (
    <Card className={CARD_CLASS}>
      <Card.Header className="gap-1.5">
        <Card.Title className="text-2xl leading-8">Welcome back</Card.Title>
        <Card.Description>
          Sign in to start a meeting or join one you were invited to.
        </Card.Description>
      </Card.Header>

      <Form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
      >
        {submission.state === 'failed' && (
          <Alert status="danger" role="alert">
            <Alert.Indicator>
              <WarningIcon />
            </Alert.Indicator>
            <Alert.Content>
              <Alert.Title>We could not sign you in</Alert.Title>
              <Alert.Description>{submission.message}</Alert.Description>
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
          autoComplete="current-password"
          // Not `validatePassword`: that enforces the registration minimum, which this form
          // must not, or an older short password could never be typed in. See its doc comment.
          validate={(value) => validateLoginPassword(value) ?? true}
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
          {/* No length hint here. Stating the policy on a sign-in form is both wrong — this
              endpoint does not apply it — and a hint to whoever is guessing. */}
          <FieldError />
        </TextField>

        <Button type="submit" variant="primary" size="lg" fullWidth isDisabled={isSubmitting}>
          {isSubmitting ? (
            <>
              <Spinner size="sm" />
              Signing you in…
            </>
          ) : (
            'Sign in'
          )}
        </Button>

        <p className="text-muted text-center text-sm">
          New here?{' '}
          <Link
            href="/auth/register"
            className="text-foreground font-medium underline-offset-4 hover:underline"
          >
            Create an account
          </Link>
        </p>
      </Form>
    </Card>
  );
}

/**
 * Turns a thrown value into something to show.
 *
 * Every failure lands in the form-level banner, with no field-level counterpart. A 401 is the
 * reason: the API answers "Invalid email or password" for an unknown address and a wrong
 * password alike, so attaching it to the email field would assert which one was wrong when
 * the server has deliberately declined to say.
 */
function describeFailure(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }

  // `fetch` rejects rather than resolving when the request never reached the API at all.
  return 'We could not reach the server. Check your connection and try again.';
}
