// External Docker CLI adapter for installer contract tests; never starts services.
const args = process.argv.slice(2);
if (args[0] === 'info') process.exit(0);
if (args[0] === 'compose' && args[1] === 'version') {
  console.log('2.29.7');
  process.exit(0);
}
if (args[0] === 'run') {
  await Bun.stdin.text();
  console.log('$2b$10$D5VbJn0dVrgh8O6DWzfrkeXQob1eOT18ivB9AsRUZvHmaZCKuZVVu');
  process.exit(0);
}
if (args[0] === 'compose' && args.includes('config')) process.exit(0);
if (args[0] === 'compose' && args.includes('up')) process.exit(0);
if (args[0] === 'compose' && args.includes('ps')) {
  if (args.at(-1) === '-q') {
    if (process.env.INSTALLER_FIXTURE_PROJECT_EXISTS === 'container') console.log('fixture-existing-container');
  } else if (args.includes('-q')) console.log(`fixture-${args.at(-1)}`);
  else console.log(JSON.stringify({ Health: 'healthy' }));
  process.exit(0);
}
if (args[0] === 'volume' && args[1] === 'ls') {
  if (process.env.INSTALLER_FIXTURE_PROJECT_EXISTS === 'volume') console.log('fixture-existing-volume');
  process.exit(0);
}
if (args[0] === 'inspect') {
  const service = args.at(-1).replace(/^fixture-/, '');
  const oneShot = ['migrate', 'seed', 'metabase-bootstrap', 'kuma-bootstrap'].includes(service);
  if (service === 'metabase-bootstrap' && process.env.INSTALLER_FIXTURE_BOOTSTRAP_STATE === 'failed') console.log('exited|1|');
  else console.log(oneShot ? 'exited|0|' : 'running|0|healthy');
  process.exit(0);
}
console.error('Unsupported Docker fixture operation');
process.exit(1);
