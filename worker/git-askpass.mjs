#!/usr/bin/env node
// Executed by trusted Git operations, never passed to Codex or repository tests.
const question = process.argv[2] || '';
process.stdout.write(/username/i.test(question) ? 'x-access-token\n' : `${process.env.PLANIFIKATEUR_GIT_TOKEN || ''}\n`);
