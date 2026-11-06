import { LoaderCircle, MessagesSquare } from 'lucide-react';

export const isJobBusy = (job) =>
  ['starting', 'running', 'collecting', 'publishing'].includes(job?.status);

export function JobStatus({ job, linked }) {
  const labels = {
    review: 'Reviewing',
    comments: 'Addressing comments',
    conflicts: 'Resolving conflicts',
    ci: 'Fixing CI',
    issue: 'Addressing issue',
    describe: 'Writing description',
  };
  const chat = job?.id || linked;
  return (
    <>
      {job?.status === 'failed' && (
        <span
          className="tag warning"
          title={job.error || 'Open the chat for details'}
        >
          Job failed
        </span>
      )}
      {job?.status === 'pending' && (
        <span className="tag">Awaiting approval</span>
      )}
      {isJobBusy(job) && (
        <span className="job-progress" role="status">
          <LoaderCircle className="job-spinner" size={14} />
          {job.status === 'starting'
            ? 'Starting…'
            : job.status === 'publishing'
              ? 'Pushing changes…'
              : job.status === 'collecting'
                ? 'Checking result…'
                : labels[job.kind] || 'Working…'}
        </span>
      )}
      {chat && (
        <a
          className="inline-action"
          href={'/sessions/' + encodeURIComponent(chat)}
          title="Open linked chat"
        >
          <MessagesSquare size={14} />
          <span>Chat</span>
        </a>
      )}
    </>
  );
}
