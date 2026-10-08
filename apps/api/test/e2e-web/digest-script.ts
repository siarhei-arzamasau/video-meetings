import { recordingsIn } from '../utils/fake-claude-agent';

/**
 * What a transcript tells the scripted Claude to do with the meeting it is part of.
 *
 * **A browser spec controls the digest by what it has the fake transcriber say.** It already
 * decides each recording's transcript, and the transcript is all of a recording that reaches
 * Claude — so a directive written into it arrives in the prompt with nothing added to the
 * API for the purpose. Directives are read from every recording of the prompt, in upload
 * order, which makes the digest of two recordings hold what both asked for, and the digest
 * that follows a delete hold only what is left: the properties the specs are about.
 *
 * | Directive                           | Does                                                |
 * | ----------------------------------- | --------------------------------------------------- |
 * | `[[digest:summary TEXT]]`           | The summary. The last one in the prompt wins        |
 * | `[[digest:action TEXT]]`            | An action item nobody was named for                 |
 * | `[[digest:action TEXT @@ NAME]]`    | An action item, and the name as it was spoken       |
 * | `[[digest:decision TEXT]]`          | A decision                                          |
 * | `[[digest:hold KEY]]`               | No answer while the spec is holding `KEY`           |
 * | `[[digest:fail]]`                   | The call fails, with words only "Anthropic" says    |
 * | `[[digest:fail KEY]]`               | It fails only while the spec is holding `KEY`       |
 *
 * A prompt with no directive at all — every recording of the specs that are not about the
 * digest — is answered with a summary and two empty lists.
 */
export interface DigestScript {
  /** The object the model would have answered with, in the shape the answer's schema asks for. */
  answer: {
    summary: string;
    actionItems: Array<{ description: string; owner: string | null }>;
    decisions: Array<{ description: string }>;
  };
  /** Keys this generation waits on. It is answered once the spec holds none of them. */
  holdKeys: string[];
  /** Fails whatever the spec does: a failure nothing but a new recording gets past. */
  fails: boolean;
  /**
   * Keys this generation fails under. With none of them held it is answered — so a spec
   * that lets go and presses Retry sees the same transcripts end in a digest.
   */
  failKeys: string[];
}

const DIRECTIVE = /\[\[digest:([a-z]+)(?:\s+([\s\S]*?))?\]\]/g;
const OWNER_SEPARATOR = '@@';

function actionItemOf(text: string): DigestScript['answer']['actionItems'][number] {
  const [description = '', owner] = text.split(OWNER_SEPARATOR).map((part) => part.trim());

  return { description, owner: owner === undefined || owner === '' ? null : owner };
}

export function digestScriptOf(prompt: string): DigestScript {
  const recordings = recordingsIn(prompt);
  const script: DigestScript = {
    answer: {
      summary: `A digest of ${String(recordings.length)} recording(s).`,
      actionItems: [],
      decisions: [],
    },
    holdKeys: [],
    fails: false,
    failKeys: [],
  };

  for (const [, name, text = ''] of recordings.join('\n').matchAll(DIRECTIVE)) {
    const value = text.trim();

    if (name === 'summary') {
      script.answer.summary = value;
    } else if (name === 'action') {
      script.answer.actionItems.push(actionItemOf(value));
    } else if (name === 'decision') {
      script.answer.decisions.push({ description: value });
    } else if (name === 'hold') {
      script.holdKeys.push(value);
    } else if (name === 'fail' && value === '') {
      script.fails = true;
    } else if (name === 'fail') {
      script.failKeys.push(value);
    }
  }

  return script;
}
