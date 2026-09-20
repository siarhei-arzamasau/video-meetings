const { execSync } = require('child_process');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('.claude/ralph.config.json', 'utf8'));
const phase = config.phases[0];

// Сбрасываем счётчик итераций
fs.writeFileSync('.claude/ralph.iterations.json', JSON.stringify({ count: 1, phaseIndex: 0 }));

// Самый старый открытый Issue фазы: `gh issue list` отдаёт по убыванию, а фазу надо идти сверху
const issues = JSON.parse(
  execSync(
    `gh issue list --milestone ${JSON.stringify(phase.milestone)} --state open --limit 100 --json number,title`,
  ).toString(),
).sort((a, b) => a.number - b.number);

if (issues.length === 0) {
  console.log(`✅ В milestone «${phase.milestone}» не осталось открытых Issue.`);
  process.exit(0);
}

const first = issues[0];
const prompt = config.prompt
  .replace('{milestone}', phase.milestone)
  .replace('{branch}', phase.branch ?? config.branch)
  .replace('{issue}', String(first.number));

console.log(`🚀 Запускаем Ralph для milestone: ${phase.milestone}`);
console.log(`🔄 Issue #${first.number}: ${first.title} (осталось ${issues.length})`);

execSync(`claude -p ${JSON.stringify(prompt)} --max-turns ${config.maxTurns}`, {
  stdio: 'inherit',
});
