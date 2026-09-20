const { execSync } = require('child_process');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('.claude/ralph.config.json', 'utf8'));

if (!config.active) process.exit(0);

const counterFile = '.claude/ralph.iterations.json';
let counter = { count: 0, phaseIndex: 0 };
if (fs.existsSync(counterFile)) {
  counter = JSON.parse(fs.readFileSync(counterFile, 'utf8'));
}

const phase = config.phases
  ? config.phases[counter.phaseIndex]
  : { milestone: config.milestone, branch: config.branch };

if (!phase) {
  console.log('🎉 All phases completed.');
  process.exit(0);
}

if (counter.count >= config.maxIterations) {
  console.log(`⛔ Iterations limit (${config.maxIterations}) reached.`);
  fs.writeFileSync(counterFile, JSON.stringify({ count: 0, phaseIndex: counter.phaseIndex }));
  process.exit(0);
}

const issues = JSON.parse(
  execSync(
    `gh issue list --milestone "${phase.milestone}" --state open --json number,title`,
  ).toString(),
);

if (issues.length > 0) {
  counter.count++;
  fs.writeFileSync(counterFile, JSON.stringify(counter));

  const next = issues[0];
  console.log(
    `🔄 Phase ${counter.phaseIndex + 1} — Iteration ${counter.count}/${config.maxIterations} — Issue #${next.number}: ${next.title}`,
  );
  console.log(`📋 Left: ${issues.length}`);

  const prompt = config.prompt
    .replace('{milestone}', phase.milestone)
    .replace('{branch}', phase.branch);

  execSync(`claude -p "${prompt}" --max-turns ${config.maxTurns}`, { stdio: 'inherit' });
} else {
  console.log(`✅ Phase ${counter.phaseIndex + 1} completed. Creating PR...`);
  execSync(
    `claude -p "Create PR from branch ${phase.branch} in main with name 'feat: ${phase.milestone}'." --model claude-opus-5 --max-turns 10`,
    { stdio: 'inherit' },
  );

  console.log('🔍 Review Opus 5...');
  execSync(
    `claude -p "Find the latest open PR and conduct a detailed code review. Check the architecture, security, performance, and adherence to the PRD. Leave comments on the PR using the gh CLI." --model claude-opus-5 --max-turns ${config.maxTurns}`,
    { stdio: 'inherit' },
  );

  counter.phaseIndex++;
  counter.count = 0;
  fs.writeFileSync(counterFile, JSON.stringify(counter));

  const nextPhase = config.phases ? config.phases[counter.phaseIndex] : null;
  if (!nextPhase) {
    console.log('🎉 All phases completed!');
    process.exit(0);
  }

  console.log(`➡️ Phase ${counter.phaseIndex + 1}: ${nextPhase.milestone}`);
  const prompt = config.prompt
    .replace('{milestone}', nextPhase.milestone)
    .replace('{branch}', nextPhase.branch);

  execSync(`claude -p "${prompt}" --max-turns ${config.maxTurns}`, { stdio: 'inherit' });
}
