const { execSync } = require('child_process');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('.claude/ralph.config.json', 'utf8'));

if (!config.active) process.exit(0);

const counterFile = '.claude/ralph.iterations.json';
let counter = { count: 0, phaseIndex: 0 };
if (fs.existsSync(counterFile)) {
  counter = JSON.parse(fs.readFileSync(counterFile, 'utf8'));
}

const phases = config.phases ?? [{ milestone: config.milestone, branch: config.branch }];
const phase = phases[counter.phaseIndex];

if (!phase) {
  console.log('🎉 All phases completed.');
  process.exit(0);
}

/** One branch for every phase unless a phase names its own. */
const branchOf = (p) => p.branch ?? config.branch;

/**
 * Runs a nested Claude session. A non-zero exit used to throw straight out of this hook and
 * end the loop silently in the middle of a milestone; now it is reported and the loop stops
 * deliberately, so the next Stop resumes from the same counter rather than from nothing.
 */
function claude(prompt, extraArgs = '') {
  try {
    execSync(`claude -p ${JSON.stringify(prompt)} ${extraArgs}`, { stdio: 'inherit' });

    return true;
  } catch (error) {
    console.log(`⛔ The session failed (${error.status ?? 'no exit code'}). Stopping the loop.`);

    return false;
  }
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

function promptFor(p, issue) {
  return config.prompt
    .replace('{milestone}', p.milestone)
    .replace('{branch}', branchOf(p))
    .replace('{issue}', issue === undefined ? '' : String(issue.number));
}

const issues = openIssuesOf(phase.milestone);

if (issues.length > 0) {
  if (counter.count >= config.maxIterations) {
    console.log(`⛔ Iterations limit (${config.maxIterations}) reached.`);
    fs.writeFileSync(counterFile, JSON.stringify({ count: 0, phaseIndex: counter.phaseIndex }));
    process.exit(0);
  }

  counter.count++;
  fs.writeFileSync(counterFile, JSON.stringify(counter));

  const next = issues[0];
  console.log(
    `🔄 Phase ${counter.phaseIndex + 1} — Iteration ${counter.count}/${config.maxIterations} — Issue #${next.number}: ${next.title}`,
  );
  console.log(`📋 Left: ${issues.length}`);

  claude(promptFor(phase, next), `--max-turns ${config.maxTurns}`);
  process.exit(0);
}

console.log(`✅ Phase ${counter.phaseIndex + 1} completed.`);

counter.phaseIndex++;
counter.count = 0;
fs.writeFileSync(counterFile, JSON.stringify(counter));

const nextPhase = phases[counter.phaseIndex];

if (nextPhase) {
  console.log(`➡️ Phase ${counter.phaseIndex + 1}: ${nextPhase.milestone}`);

  const first = openIssuesOf(nextPhase.milestone)[0];

  if (!first) {
    console.log('Nothing open in it; the next Stop will move on again.');
    process.exit(0);
  }

  counter.count = 1;
  fs.writeFileSync(counterFile, JSON.stringify(counter));
  claude(promptFor(nextPhase, first), `--max-turns ${config.maxTurns}`);
  process.exit(0);
}

/*
 * Every phase is done. The PR is created here and only here: all the phases share one branch,
 * so opening one per phase would mean four `gh pr create` calls against a pull request that
 * already exists.
 */
const branch = branchOf(phase);

console.log('🎉 All phases completed. Creating the PR...');

if (
  claude(
    `Create PR from branch ${branch} into main with name 'feat: user profile'. Push the branch first if the remote is behind.`,
    '--model claude-opus-5 --max-turns 20',
  )
) {
  console.log('🔍 Review Opus 5...');
  claude(
    'Find the latest open PR and conduct a detailed code review. Check the architecture, security, performance, and adherence to the PRD. Leave comments on the PR using the gh CLI.',
    `--model claude-opus-5 --max-turns ${config.maxTurns}`,
  );
}
