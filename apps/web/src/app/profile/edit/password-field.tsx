'use client';

import {
  Button,
  Description,
  FieldError,
  InputGroup,
  Label,
  TextField,
  type TextFieldProps,
} from '@heroui/react';
import type { ReactNode } from 'react';

import { EyeIcon, EyeOffIcon, LockIcon } from '@/components/icons';

/**
 * One password input, with the lock prefix, the field-level error slot, and — on the field
 * that asks for it — the control that reveals all three at once.
 *
 * It exists because the change-password form has three of these and they differ only in their
 * label, their `autoComplete`, and the rule they validate against. Three copies of the same
 * twenty lines of `InputGroup` would be three places for the markup to drift, and the reveal
 * toggle in particular has to look and behave the same wherever it is.
 *
 * `type` is decided here from `isRevealed` rather than passed in, so a caller cannot render a
 * password field that shows its value while the toggle says it is hidden.
 */
export function PasswordField({
  name,
  label,
  autoComplete,
  value,
  isRevealed,
  isDisabled,
  validate,
  description,
  onChange,
  onToggleReveal,
}: {
  name: string;
  label: string;
  autoComplete: 'current-password' | 'new-password';
  value: string;
  isRevealed: boolean;
  isDisabled: boolean;
  validate: NonNullable<TextFieldProps['validate']>;
  description?: ReactNode;
  onChange: (value: string) => void;
  /** Omitted on the fields that do not carry the toggle; one form shows one of these. */
  onToggleReveal?: () => void;
}) {
  return (
    <TextField
      name={name}
      type={isRevealed ? 'text' : 'password'}
      value={value}
      onChange={onChange}
      isDisabled={isDisabled}
      autoComplete={autoComplete}
      validate={validate}
      fullWidth
    >
      <Label>{label}</Label>
      <InputGroup fullWidth>
        <InputGroup.Prefix>
          <LockIcon />
        </InputGroup.Prefix>
        <InputGroup.Input placeholder="••••••••" />
        {onToggleReveal !== undefined && (
          <InputGroup.Suffix>
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              // Not a form control: excluded from the submitted values, and labelled by state
              // because the icon alone does not say which way it is about to go. Plural,
              // because one toggle governs every password field in the form — they are typed
              // in sequence and a reader checking a typo wants to see the sequence.
              aria-label={isRevealed ? 'Hide passwords' : 'Show passwords'}
              onPress={onToggleReveal}
            >
              {isRevealed ? <EyeOffIcon /> : <EyeIcon />}
            </Button>
          </InputGroup.Suffix>
        )}
      </InputGroup>
      {description !== undefined && <Description>{description}</Description>}
      <FieldError />
    </TextField>
  );
}
