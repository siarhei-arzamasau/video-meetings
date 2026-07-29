/** @type {import('@commitlint/types').UserConfig} */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      ['api', 'web', 'shared', 'tsconfig', 'ci', 'docker', 'deps', 'repo', 'docs'],
    ],
  },
};
