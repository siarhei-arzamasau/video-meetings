const { execSync } = require('child_process');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('.claude/ralph.config.json', 'utf8'));

// Reset the iteration counter
fs.writeFileSync('.claude/ralph.iterations.json', JSON.stringify({ count: 0, phaseIndex: 0 }));

// Run the first iteration
const prompt = config.prompt
  .replace('{milestone}', config.phases[0].milestone)
  .replace('{branch}', config.phases[0].branch);
console.log(`🚀 Starting Ralph for milestone: ${config.phases[0].milestone}`);

execSync(`claude -p "${prompt}" --max-turns ${config.maxTurns}`, { stdio: 'inherit' });
