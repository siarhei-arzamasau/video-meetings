const { execSync } = require('child_process');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('.claude/ralph.config.json', 'utf8'));
const phase = config.phases[0];

// Reset the iteration counter
fs.writeFileSync('.claude/ralph.iterations.json', JSON.stringify({ count: 1, phaseIndex: 0 }));

// Oldest issue first: `gh issue list` answers newest first, which walks a phase backwards.
const issues = JSON.parse(
  execSync(
    `gh issue list --milestone ${JSON.stringify(phase.milestone)} --state open --limit 100 --json number,title`,
  ).toString(),
).sort((a, b) => a.number - b.number);

if (issues.length === 0) {
  console.log(`✅ Nothing open left in "${phase.milestone}".`);
  process.exit(0);
}

const first = issues[0];
const prompt = config.prompt
  .replace('{milestone}', phase.milestone)
  .replace('{branch}', phase.branch ?? config.branch)
  .replace('{issue}', String(first.number));

console.log(`🚀 Starting Ralph for milestone: ${phase.milestone}`);
console.log(`🔄 Issue #${first.number}: ${first.title} (${issues.length} left)`);

execSync(`claude -p ${JSON.stringify(prompt)} --max-turns ${config.maxTurns}`, {
  stdio: 'inherit',
});
