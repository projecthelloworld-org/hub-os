import nodemailer from 'nodemailer';

export function createNotificationSender(env = process.env, createTransport = nodemailer.createTransport) {
  const mode = env.HUBOS_NOTIFICATION_MODE ?? 'local';
  if (mode === 'disabled') return null;
  if (!['local', 'smtp'].includes(mode)) throw new Error('Invalid notification mode');
  if (mode === 'smtp' && !env.HUBOS_SMTP_HOST) throw new Error('SMTP requires a configured host and recipients');
  const recipients = (env.HUBOS_NOTIFICATION_RECIPIENTS || (mode === 'local' ? 'operator@hubos.local' : ''))
    .split(',').map((item) => item.trim()).filter(Boolean);
  if (!recipients.length || recipients.some((item) => !/^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(item))) {
    throw new Error('SMTP requires configured valid recipients');
  }
  const transport = createTransport({
    host: mode === 'local' ? env.HUBOS_LOCAL_SMTP_HOST ?? 'mailpit' : env.HUBOS_SMTP_HOST,
    port: mode === 'local' ? Number(env.HUBOS_LOCAL_SMTP_PORT ?? 1025) : Number(env.HUBOS_SMTP_PORT ?? 587),
    secure: mode === 'smtp' && env.HUBOS_SMTP_SECURE === 'true',
    requireTLS: mode === 'smtp' && env.HUBOS_SMTP_SECURE !== 'true',
    auth: mode === 'smtp' && env.HUBOS_SMTP_USERNAME
      ? { user: env.HUBOS_SMTP_USERNAME, pass: env.HUBOS_SMTP_PASSWORD } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
  });
  return async (job) => {
    await transport.sendMail({
      from: env.HUBOS_NOTIFICATION_FROM ?? 'hubos-alerts@local.test', to: recipients,
      messageId: `<${job.id}@hubos.local>`, subject: `[HubOS ${job.event_kind}] ${job.incident.title}`,
      text: `${job.incident.title}\nSeverity: ${job.incident.severity}\nEvent: ${job.event_kind}\nIncident: ${job.incident.id}\n`,
    });
  };
}

export async function deliverNextNotification({ store, send }) {
  if (!send) return null;
  const job = await store.claimNotification();
  if (!job) return null;
  try {
    await send(job);
    await store.finishNotification(job);
    return { delivered: true, id: job.id };
  } catch (error) {
    await store.finishNotification(job, error);
    return { delivered: false, id: job.id };
  }
}
