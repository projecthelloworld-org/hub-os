// Own isolated fixture only; CLI setup writes never belong to the collector.
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const compose = ['docker', 'compose', '-p', 'hubos-v02-odk-test', '-f', `${root}/compose/odk-test.compose.yaml`];
const email = `fixture-${crypto.randomUUID()}@example.invalid`;
const password = 'Fixture-ODK-Administrator-2026!';
async function run(args, { input, env, testOutput = false } = {}) {
  const child = Bun.spawn([...compose, ...args], { cwd: root, env: { ...process.env, ...env },
    stdin: input === undefined ? 'ignore' : new Blob([input]), stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 180000);
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  clearTimeout(timer);
  if (testOutput) {
    console.log(stdout);
    console.log(stderr);
  }
  if (code !== 0) throw new Error(`ODK_FIXTURE_COMMAND_FAILED:${args[0]}:${code}`);
  return { stdout, stderr };
}
const validation = await run(['run', '--rm', '--no-deps', 'validator']);
if (!validation.stdout.includes('Validating: /forms/hubos-inspection.xml') || !validation.stdout.includes('Xform is valid!')) {
  throw new Error('ODK_FORM_VALIDATION_INCOMPLETE');
}
console.log('The bundled inspection XForm passed the upstream Java validator.');
const configuration = await run(['exec', '-T', 'service', 'node', '-e', `
const c=require('config').default;
console.log(JSON.stringify({domain:c.env.domain,sentryDisabled:!c.external.sentry.key&&!c.external.sentry.project&&!c.external.sentry.orgSubdomain,
reportingDisabled:!c.external.analytics.url&&!c.external.mailingListOptIn.url,mailHost:c.email.transportOpts.host}));`]);
const safe = JSON.parse(configuration.stdout);
if (safe.domain !== 'http://service:8383' || !safe.sentryDisabled || !safe.reportingDisabled || safe.mailHost !== 'mailpit') {
  throw new Error('ODK_FIXTURE_CONFIGURATION_UNSAFE');
}
console.log('Verified internal canonical domain, disabled external reporting and Mailpit-only email.');
await run(['exec', '-T', 'service', 'odk-cmd', '--email', email, 'user-create'], { input: `${password}\n` });
await run(['exec', '-T', 'service', 'odk-cmd', '--email', email, 'user-promote']);
console.log('Created a unique administrator in the owned ODK fixture.');
await run(['run', '--rm', '--no-deps', 'client'], {
  env: { HUBOS_TEST_ODK_ADMIN_EMAIL: email, HUBOS_TEST_ODK_ADMIN_PASSWORD: password }, testOutput: true,
});
