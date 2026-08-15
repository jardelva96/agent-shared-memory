import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, boolFlag, stringFlag } from '../src/cli/args.js';

test('global flags are accepted on either side of the command', () => {
  const after = parseArgs(['status', '--root', '/tmp/x', '--json']);
  const before = parseArgs(['--root', '/tmp/x', 'status', '--json']);
  const around = parseArgs(['--root', '/tmp/x', '--json', 'status']);

  for (const parsed of [after, before, around]) {
    assert.equal(parsed.command, 'status');
    assert.equal(stringFlag(parsed.flags, 'root'), '/tmp/x');
    assert.equal(boolFlag(parsed.flags, 'json'), true);
  }
});

test('a flag value is never mistaken for the command', () => {
  // "status" here is the value of --root, not the command.
  const parsed = parseArgs(['--root', 'status', 'memory']);
  assert.equal(parsed.command, 'memory');
  assert.equal(stringFlag(parsed.flags, 'root'), 'status');
});

test('positionals after the command are preserved', () => {
  const parsed = parseArgs(['register', 'AGENT-01', '--role', 'Backend']);
  assert.equal(parsed.command, 'register');
  assert.deepEqual(parsed.positionals, ['AGENT-01']);
  assert.equal(stringFlag(parsed.flags, 'role'), 'Backend');
});

test('a bare --help has no command, so help is printed instead of failing', () => {
  const parsed = parseArgs(['--help']);
  assert.equal(parsed.command, undefined);
  assert.equal(boolFlag(parsed.flags, 'help'), true);
});

test('no arguments at all yields no command', () => {
  const parsed = parseArgs([]);
  assert.equal(parsed.command, undefined);
  assert.deepEqual(parsed.positionals, []);
});
