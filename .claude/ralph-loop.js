/*
 * The Ralph loop as one long-lived process.
 *
 * **Why not the Stop hook.** The loop used to chain itself: every session's Stop hook ran the
 * next session with `execSync`, so session N lived inside session N-1's hook. A hook has a
 * timeout — 60 seconds unless `settings.json` says otherwise — and a session that implements
 * an issue needs tens of minutes, so each child was killed long before it could commit. The
 * symptom was an iteration counter that kept climbing over a branch that never gained a commit,
 * and scratch files left behind by sessions that died mid-edit.
 *
 * So the loop lives here instead: one driver process, one session at a time, each run to
 * completion before the next is chosen. Nothing nests, nothing times out, and Ctrl-C stops it.
 * `ralph.config.json` keeps `active: false` so the Stop hook stays out of the way.
 */
const { execSync } = require('child_process');
const fs = require('fs');

const CONFIG_FILE = '.claude/ralph.config.json';
const COUNTER_FILE = '.claude/ralph.iterations.json';

/** One issue attempted twice without closing means the loop is not moving; stop rather than spin. */
const MAX_ATTEMPTS_PER_ISSUE = 2;

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const phases = config.phases ?? [{ milestone: config.milestone, branch: config.branch }];

function readCounter() {
  if (!fs.existsSync(COUNTER_FILE)) return { count: 0, phaseIndex: 0 };

  return JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
}

function writeCounter(counter) {
  fs.writeFileSync(COUNTER_FILE, JSON.stringify(counter));
}

/** One branch for every phase unless a phase names its own. */
function branchOf(phase) {
  return phase.branch ?? config.branch;
}

/** Oldest first. `gh issue list` answers newest first, which walks a phase backwards. */
function openIssuesOf(milestone) {
  const issues = JSON.parse(
    execSync(
      `gh issue list --milestone ${JSON.stringify(milestone)} --state open --limit 100 --json number,title`,
    ).toString(),
  );

  return issues.sort((a, b) => a.number - b.number);
}

function promptFor(phase, issue) {
  return config.prompt
    .replace('{milestone}', phase.milestone)
    .replace('{branch}', branchOf(phase))
    .replace('{issue}', String(issue.number));
}

function runSession(prompt, extraArgs) {
  try {
    execSync(`claude -p ${JSON.stringify(prompt)} ${extraArgs}`, { stdio: 'inherit' });

    return true;
  } catch (error) {
    console.log(`\nThe session exited with ${error.status ?? 'no exit code'}.`);

    return false;
  }
}

function runPhases() {
  let counter = readCounter();
  let lastIssueNumber;
  let attempts = 0;

  /*
   * A counter left past the last phase means the previous run finished. Falling through to the
   * PR below would open one and run a full review having done no work — which is what someone
   * gets for restarting the driver to check where it got to.
   */
  if (counter.phaseIndex >= phases.length) {
    console.log('Every phase was already complete. Reset .claude/ralph.iterations.json to rerun.');
    process.exit(0);
  }

  while (counter.phaseIndex < phases.length) {
    const phase = phases[counter.phaseIndex];
    const issues = openIssuesOf(phase.milestone);

    if (issues.length === 0) {
      console.log(`\nPhase ${counter.phaseIndex + 1} completed: ${phase.milestone}`);
      counter = { count: 0, phaseIndex: counter.phaseIndex + 1 };
      writeCounter(counter);
      lastIssueNumber = undefined;
      attempts = 0;
      continue;
    }

    if (counter.count >= config.maxIterations) {
      console.log(
        `\nIteration limit (${config.maxIterations}) reached in phase ${counter.phaseIndex + 1}.`,
      );

      return false;
    }

    const issue = issues[0];

    attempts = issue.number === lastIssueNumber ? attempts + 1 : 1;
    lastIssueNumber = issue.number;

    if (attempts > MAX_ATTEMPTS_PER_ISSUE) {
      console.log(
        `\nIssue #${issue.number} is still open after ${MAX_ATTEMPTS_PER_ISSUE} attempts. Stopping.`,
      );

      return false;
    }

    counter.count++;
    writeCounter(counter);

    console.log(
      `\nPhase ${counter.phaseIndex + 1}/${phases.length} - iteration ${counter.count}/${config.maxIterations} - issue #${issue.number}: ${issue.title}`,
    );
    console.log(`${issues.length} left in this phase.`);

    if (!runSession(promptFor(phase, issue), `--max-turns ${config.maxTurns}`)) return false;
  }

  return true;
}

if (!runPhases()) process.exit(1);

/*
 * The PR is created here and only here: every phase shares one branch, so opening one per phase
 * would mean five `gh pr create` calls against a pull request that already exists.
 */
const branch = branchOf(phases[phases.length - 1]);

console.log('\nEvery phase is done. Creating the PR.');

if (
  runSession(
    `Create PR from branch ${branch} into main with name 'feat: user profile'. Push the branch first if the remote is behind.`,
    '--model claude-opus-5 --max-turns 20',
  )
) {
  console.log('\nReviewing the PR.');
  runSession(
    'Find the latest open PR and conduct a detailed code review. Check the architecture, security, performance, and adherence to the PRD. Leave comments on the PR using the gh CLI.',
    `--model claude-opus-5 --max-turns ${config.maxTurns}`,
  );
}
