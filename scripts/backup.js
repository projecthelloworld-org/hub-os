#!/usr/bin/env bun
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const helperImage = 'caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648';
const coreFiles = ['compose.yaml', 'compose/mel.compose.yaml', 'compose/monitoring.compose.yaml'];
const writers = ['api', 'worker', 'metabase', 'kuma', 'caddy'];
const volumeTargets = {
  'kuma-data': ['kuma', '/app/data'], 'hubos-secrets': ['worker', '/run/hubos-secrets'],
  'caddy-data': ['caddy', '/data'], 'caddy-config': ['caddy', '/config'],
};
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const within = (parent, candidate) => {
  const path = relative(parent, candidate);
  return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
};
let cancellationRequested = false;
const dockerEnvironment = () => Object.fromEntries(['PATH', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']
  .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));

async function command(args, { cwd, stdin = 'ignore', output, timeout = 300000 } = {}) {
  if (cancellationRequested) fail('RECOVERY_INTERRUPTED');
  let handle;
  if (output) handle = await open(output, 'wx', 0o600);
  const child = Bun.spawn(args, { cwd, env: dockerEnvironment(), stdin, stdout: handle ? handle.fd : 'pipe', stderr: 'ignore' });
  const timer = setTimeout(() => child.kill(), timeout);
  try {
    const [text, status] = await Promise.all([handle ? Promise.resolve('') : new Response(child.stdout).text(), child.exited]);
    if (cancellationRequested) fail('RECOVERY_INTERRUPTED');
    if (status !== 0) fail('RECOVERY_COMMAND_FAILED');
    return text.trim();
  } finally { clearTimeout(timer); await handle?.close(); }
}

async function digest(path) {
  const hasher = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest('hex');
}

async function privateCopy(source, target) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) fail('RECOVERY_CONFIGURATION_SYMLINK');
  if (info.isDirectory()) {
    await mkdir(target, { mode: 0o700 });
    for (const name of await readdir(source)) await privateCopy(join(source, name), join(target, name));
  } else if (info.isFile()) {
    await copyFile(source, target, 1);
    await chmod(target, 0o600);
  } else fail('RECOVERY_UNSUPPORTED_CONFIGURATION_FILE');
}

async function filesUnder(directory, prefix = '') {
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name), key = prefix ? `${prefix}/${name}` : name;
    const info = await lstat(path);
    if (info.isSymbolicLink()) fail('RECOVERY_CONFIGURATION_SYMLINK');
    if (info.isDirectory()) files.push(...await filesUnder(path, key));
    else if (info.isFile()) files.push(key);
    else fail('RECOVERY_UNSUPPORTED_CONFIGURATION_FILE');
  }
  return files;
}

async function deployment(directory, projectOverride) {
  directory = await realpath(directory);
  for (const name of ['.env', ...coreFiles]) {
    const info = await lstat(join(directory, name));
    if (!info.isFile() || info.isSymbolicLink()) fail('RECOVERY_DEPLOYMENT_CONFIGURATION_REQUIRED');
  }
  let files = [...coreFiles];
  const compose = (args) => command(['docker', 'compose', '--env-file', join(directory, '.env'),
    ...(projectOverride ? ['-p', projectOverride] : []), ...files.flatMap((file) => ['-f', file]), ...args], { cwd: directory });
  let configuration = JSON.parse(await compose(['config', '--format', 'json']));
  if (configuration.services.api.environment.HUBOS_DEMO_MODE === 'true') files.push('compose/development.compose.yaml');
  if (configuration.services.api.environment.HUBOS_SITE_ADDRESS !== ':80') files.push('compose/tls.compose.yaml');
  configuration = JSON.parse(await compose(['config', '--format', 'json']));
  const project = configuration.name;
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) fail('RECOVERY_INVALID_PROJECT');
  return { directory, project, compose, configuration };
}

async function service(context, name) {
  const id = await context.compose(['ps', '--all', '-q', name]);
  if (!id || /\s/.test(id)) fail('RECOVERY_SINGLE_SERVICE_CONTAINER_REQUIRED');
  const identity = JSON.parse(await command(['docker', 'inspect', '--format',
    '{"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},"state":{{json .State.Status}},"image":{{json .Image}}}', id]));
  const workingDirectory = await realpath(identity.labels['com.docker.compose.project.working_dir']);
  if (identity.labels['com.docker.compose.project'] !== context.project || workingDirectory !== context.directory
    || identity.labels['com.docker.compose.service'] !== name) fail('RECOVERY_PROJECT_IDENTITY_MISMATCH');
  return { id, ...identity };
}

async function createBackup({ directory, output, confirmPause }) {
  if (!confirmPause) fail('RECOVERY_REQUIRES_CONFIRM_PAUSE');
  if (!directory || !output) fail('RECOVERY_DIRECTORY_AND_OUTPUT_REQUIRED');
  const context = await deployment(directory);
  output = resolve(output);
  if (within(context.directory, output)) fail('RECOVERY_OUTPUT_MUST_BE_OUTSIDE_DEPLOYMENT');
  const services = {};
  const provisioners = ['migrate', 'metabase-bootstrap', 'kuma-bootstrap', ...(context.configuration.services.seed ? ['seed'] : [])];
  for (const name of [...writers, 'db', 'metabase-db', ...provisioners]) services[name] = await service(context, name);
  for (const name of provisioners) {
    if (services[name].state === 'running') fail('RECOVERY_PROVISIONING_IN_PROGRESS');
  }
  for (const name of ['db', 'metabase-db']) if (services[name].state !== 'running') fail('RECOVERY_DATABASE_NOT_RUNNING');
  const volumes = {};
  for (const [name, [owner, destination]] of Object.entries(volumeTargets)) {
    const mount = services[owner].mounts.find((mount) => mount.Type === 'volume' && mount.Destination === destination);
    if (!mount || !/^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(mount.Name)) fail('RECOVERY_VOLUME_REQUIRED');
    const labels = JSON.parse(await command(['docker', 'volume', 'inspect', '--format', '{{json .Labels}}', mount.Name]));
    if (labels?.['com.docker.compose.project'] !== context.project || labels?.['com.docker.compose.volume'] !== name) fail('RECOVERY_VOLUME_IDENTITY_MISMATCH');
    volumes[name] = mount.Name;
  }
  const lock = join(context.directory, '.hubos-recovery.lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch { fail('RECOVERY_LOCK_EXISTS'); }
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, project: context.project,
    started_at: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
  const cancel = () => { cancellationRequested = true; };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  const running = writers.filter((name) => services[name].state === 'running');
  let paused = false, completed = false;
  try {
    await mkdir(output, { mode: 0o700 });
    await mkdir(join(output, 'database'), { mode: 0o700 });
    await mkdir(join(output, 'volumes'), { mode: 0o700 });
    await mkdir(join(output, 'configuration'), { mode: 0o700 });
    paused = true;
    if (running.length) await context.compose(['stop', ...running]);
    for (const name of writers) if ((await service(context, name)).state === 'running') fail('RECOVERY_WRITER_STILL_RUNNING');
    for (const name of ['.env', '.hubos-credentials', 'config', 'plugins']) {
      try { await lstat(join(context.directory, name)); } catch (error) { if (error.code === 'ENOENT' && name !== '.env') continue; throw error; }
      await privateCopy(join(context.directory, name), join(output, 'configuration', name));
    }
    for (const [name, file] of [['db', 'core.dump'], ['metabase-db', 'metabase.dump']]) {
      await command(['docker', 'exec', services[name].id, 'sh', '-c',
        'exec pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format=custom --no-owner --no-acl'],
      { output: join(output, 'database', file) });
    }
    for (const [name, volume] of Object.entries(volumes)) {
      await command(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'tar',
        '--mount', `type=volume,src=${volume},dst=/snapshot,readonly`, helperImage, '-C', '/snapshot', '-czf', '-', '.'],
      { output: join(output, 'volumes', `${name}.tar.gz`) });
    }
    const artifacts = [];
    for (const path of await filesUnder(output)) artifacts.push({ path, sha256: await digest(join(output, path)) });
    if (cancellationRequested) fail('RECOVERY_INTERRUPTED');
    const manifest = { format: 'hubos-backup-v1', created_at: new Date().toISOString(), project: context.project,
      consistency: 'writers-paused', hubos_version: JSON.parse(await readFile(join(context.directory, 'services/hubos/package.json'), 'utf8')).version,
      images: Object.fromEntries(Object.entries(services).map(([name, service]) => [name, service.image])),
      artifacts };
    await writeFile(join(output, 'manifest.json.pending'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(join(output, 'manifest.json.pending'), join(output, 'manifest.json'));
    completed = true;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    cancellationRequested = false;
    let resumed = false;
    try {
      if (paused && running.length) await context.compose(['start', '--wait', '--wait-timeout', '120', ...running]);
      resumed = true;
    } finally {
      if (resumed) { await unlink(join(lock, 'owner.json')); await rmdir(lock); }
      else console.error('RECOVERY_RESUME_REQUIRED_LOCK_RETAINED');
    }
  }
  if (completed) console.log(`Complete private backup: ${output}\nProtect this directory; it contains credentials and is not encrypted.`);
}

async function verifyBackup(backup) {
  if (!backup) fail('RECOVERY_BACKUP_DIRECTORY_REQUIRED');
  const directory = await realpath(backup);
  let manifest;
  try {
    const file = Bun.file(join(directory, 'manifest.json'));
    if (file.size > 2000000) fail('RECOVERY_BACKUP_MANIFEST_INVALID');
    manifest = await file.json();
  } catch { fail('RECOVERY_BACKUP_MANIFEST_INVALID'); }
  if (manifest.format !== 'hubos-backup-v1' || manifest.consistency !== 'writers-paused'
    || !Array.isArray(manifest.artifacts) || manifest.artifacts.length > 100000) fail('RECOVERY_BACKUP_MANIFEST_INVALID');
  const paths = new Set();
  for (const artifact of manifest.artifacts) {
    const path = artifact.path;
    if (typeof path !== 'string' || isAbsolute(path) || path.includes('\\') || /[\u0000-\u001f]/.test(path)
      || path.split('/').some((part) => !part || part === '.' || part === '..')
      || !['configuration', 'database', 'volumes'].includes(path.split('/')[0])
      || paths.has(path) || !/^[a-f0-9]{64}$/.test(artifact.sha256)) fail('RECOVERY_BACKUP_PATH_INVALID');
    paths.add(path);
    const candidate = join(directory, path);
    const canonical = await realpath(candidate);
    if (!within(directory, canonical) || (await lstat(candidate)).isSymbolicLink()) fail('RECOVERY_BACKUP_PATH_INVALID');
    if (!(await lstat(candidate)).isFile() || await digest(candidate) !== artifact.sha256) fail('RECOVERY_BACKUP_CHECKSUM_MISMATCH');
  }
  for (const path of ['configuration/.env', 'database/core.dump', 'database/metabase.dump',
    ...Object.keys(volumeTargets).map((key) => `volumes/${key}.tar.gz`)]) {
    if (!paths.has(path)) fail('RECOVERY_BACKUP_REQUIRED_ARTIFACT_MISSING');
  }
  const actual = (await filesUnder(directory)).filter((path) => path !== 'manifest.json');
  if (actual.length !== paths.size || actual.some((path) => !paths.has(path))) fail('RECOVERY_BACKUP_UNDECLARED_ARTIFACT');
  return { directory, manifest };
}

async function restoreBackup({ backup, directory, project, confirmIsolated }) {
  if (!confirmIsolated) fail('RECOVERY_REQUIRES_CONFIRM_ISOLATED');
  const snapshot = await verifyBackup(backup);
  if (!directory || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project ?? '') || project === snapshot.manifest.project) {
    fail('RECOVERY_DISTINCT_TARGET_PROJECT_REQUIRED');
  }
  directory = await realpath(directory);
  if (within(snapshot.directory, directory) || within(directory, snapshot.directory)) fail('RECOVERY_TARGET_OVERLAPS_BACKUP');
  const version = JSON.parse(await readFile(join(directory, 'services/hubos/package.json'), 'utf8')).version;
  if (version !== snapshot.manifest.hubos_version) fail('RECOVERY_MATCHING_PACKAGE_REQUIRED');
  for (const name of ['.env', '.hubos-credentials', 'config', 'plugins', '.hubos-restore.json']) {
    try { await lstat(join(directory, name)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    fail('RECOVERY_TARGET_CONFIGURATION_NOT_EMPTY');
  }
  for (const [kind, filter] of [['ps', ['--all', '--quiet']], ['volume', ['ls', '--quiet']]]) {
    if (await command(['docker', kind, ...filter, '--filter', `label=com.docker.compose.project=${project}`])) {
      fail('RECOVERY_TARGET_PROJECT_NOT_EMPTY');
    }
  }
  // Check archive members before creating target storage. Helpers have no network,
  // Docker socket or writable host mount; only the new target volume is writable.
  for (const name of Object.keys(volumeTargets)) {
    const path = join(snapshot.directory, 'volumes', `${name}.tar.gz`);
    const args = ['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'tar',
      '--mount', `type=bind,src=${path},dst=/archive,readonly`, helperImage];
    const listing = await command([...args, '-tzf', '/archive']);
    if (listing.split('\n').some((path) => !path.startsWith('./') || path.split('/').includes('..') || /[\u0000-\u001f]/.test(path))) {
      fail('RECOVERY_UNSAFE_ARCHIVE_PATH');
    }
    const details = await command([...args, '-tvzf', '/archive']);
    if (details.split('\n').some((line) => !['d', '-'].includes(line[0]))) fail('RECOVERY_UNSUPPORTED_ARCHIVE_ENTRY');
  }
  const configuration = join(snapshot.directory, 'configuration');
  for (const name of await readdir(configuration)) {
    if (!['.env', '.hubos-credentials', 'config', 'plugins'].includes(name)) fail('RECOVERY_BACKUP_CONFIGURATION_INVALID');
  }
  for (const name of await readdir(configuration)) await privateCopy(join(configuration, name), join(directory, name));
  await writeFile(join(directory, '.env'), `\nCOMPOSE_PROJECT_NAME=${project}\nHUBOS_NOTIFICATION_MODE=disabled\n`, { flag: 'a', mode: 0o600 });
  const context = await deployment(directory, project);
  for (const [name, volume] of Object.entries(context.configuration.volumes)) {
    if (volume.external || volume.name !== `${project}_${name}`) fail('RECOVERY_PROJECT_OWNED_VOLUMES_REQUIRED');
    const existing = await command(['docker', 'volume', 'ls', '--quiet', '--filter', `name=^${volume.name}$`]);
    if (existing) fail('RECOVERY_TARGET_VOLUME_NOT_EMPTY');
  }
  const requiredImages = [...writers, 'db', 'metabase-db', 'migrate', 'metabase-bootstrap', 'kuma-bootstrap',
    ...(context.configuration.services.seed ? ['seed'] : [])];
  if (!snapshot.manifest.images || requiredImages.some((name) => !Object.hasOwn(snapshot.manifest.images, name))) {
    fail('RECOVERY_IMAGE_METADATA_INVALID');
  }
  for (const [name, expected] of Object.entries(snapshot.manifest.images)) {
    const image = context.configuration.services[name]?.image;
    if (!image || !/^sha256:[a-f0-9]{64}$/.test(expected)) fail('RECOVERY_IMAGE_METADATA_INVALID');
    if (await command(['docker', 'image', 'inspect', '--format', '{{.Id}}', image]) !== expected) fail('RECOVERY_MATCHING_IMAGES_REQUIRED');
  }
  await writeFile(join(directory, '.hubos-restore.json'), JSON.stringify({ state: 'incomplete', project,
    source_project: snapshot.manifest.project, created_at: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
  try {
    await context.compose(['up', '--detach', '--no-build', '--wait', '--wait-timeout', '120', 'db', 'metabase-db']);
    for (const [name, file] of [['db', 'core.dump'], ['metabase-db', 'metabase.dump']]) {
      const database = await service(context, name);
      await command(['docker', 'exec', '-i', database.id, 'sh', '-c',
        'exec pg_restore --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --no-owner --no-acl --exit-on-error --single-transaction'],
      { stdin: Bun.file(join(snapshot.directory, 'database', file)) });
    }
    for (const name of Object.keys(volumeTargets)) {
      const volume = context.configuration.volumes[name].name;
      if (await command(['docker', 'volume', 'ls', '--quiet', '--filter', `name=^${volume}$`])) fail('RECOVERY_TARGET_VOLUME_NOT_EMPTY');
      await command(['docker', 'volume', 'create', '--label', `com.docker.compose.project=${project}`,
        '--label', `com.docker.compose.volume=${name}`, volume]);
      await command(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'sh',
        '--mount', `type=volume,src=${volume},dst=/target`,
        '--mount', `type=bind,src=${join(snapshot.directory, 'volumes', `${name}.tar.gz`)},dst=/archive,readonly`,
        helperImage, '-c', 'test -z "$(ls -A /target)" && exec tar -xzf /archive -C /target']);
    }
    await context.compose(['create', '--no-build', ...writers]);
    for (const [name, [owner, destination]] of Object.entries(volumeTargets)) {
      const container = await service(context, owner);
      const mount = container.mounts.find((entry) => entry.Type === 'volume' && entry.Destination === destination);
      if (!mount || mount.Name !== context.configuration.volumes[name].name) fail('RECOVERY_TARGET_VOLUME_IDENTITY_MISMATCH');
    }
    await writeFile(join(directory, '.hubos-restore.json'), JSON.stringify({ state: 'restored-not-started', project,
      source_project: snapshot.manifest.project, created_at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  } finally {
    await context.compose(['stop', 'db', 'metabase-db']);
  }
  console.log('Restore completed in isolated storage; applications remain stopped and notifications disabled. Review source targets, monitor targets, ports and secret references before startup.');
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || args.includes('--help')) {
    console.log('HubOS recovery tools (Bun 1.3.14+ and Docker Compose)\ncreate --directory PATH --output NEW_DIRECTORY --confirm-pause\nverify --backup DIRECTORY\nrestore --backup DIRECTORY --directory CLEAN_PACKAGE --project NEW_PROJECT --confirm-isolated\nBackups contain private configuration, both databases, Kuma/secret and Caddy storage. Restore requires the matching package/images and leaves applications stopped.');
    return;
  }
  const action = args.shift(), options = {};
  while (args.length) {
    const argument = args.shift();
    if (argument === '--confirm-pause') options.confirmPause = true;
    else if (argument === '--confirm-isolated') options.confirmIsolated = true;
    else if (['--directory', '--output', '--backup', '--project'].includes(argument) && args.length) options[argument.slice(2)] = args.shift();
    else fail('RECOVERY_INVALID_ARGUMENT');
  }
  if (action === 'create') await createBackup(options);
  else if (action === 'verify') { await verifyBackup(options.backup); console.log('Backup artifact integrity verified; authenticity and storage protection remain the operator responsibility.'); }
  else if (action === 'restore') await restoreBackup(options);
  else fail('RECOVERY_UNKNOWN_ACTION');
}
if (import.meta.main) {
  try { await main(); } catch (error) { console.error(`HubOS recovery failed: ${error.code ?? 'RECOVERY_FAILED'}`); process.exitCode = 1; }
}
