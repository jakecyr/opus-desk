import { isJobBusy } from './job-state.js';

export const pullQueues = [
  ['needs-review', 'Needs review'],
  ['in-review', 'In review'],
  ['mine', 'My pull requests'],
  ['other', 'Other pull requests'],
  ['closed', 'Closed'],
];

export const pullFilters = [
  ['ready', 'Ready to merge'],
  ['pending', 'Draft comments'],
  ['reply', 'Pending my response'],
  ['feedback', 'Unaddressed comments'],
  ['failing', 'Failing CI'],
  ['conflicts', 'Conflicts'],
  ['draft', 'Draft PRs'],
];

export const isOpen = (pr) => pr.state?.toUpperCase() === 'OPEN';
export const isMine = (pr) => !!pr.roles?.includes('authored');
export const wasReviewed = (pr) =>
  !!(pr.reviewedByMe || pr.roles?.includes('reviewed'));
export const hasConflict = (pr) => pr.mergeable === 'CONFLICTING';
export const hasFailedChecks = (pr) =>
  !!(pr.failedChecks?.length || ['FAILURE', 'ERROR'].includes(pr.checkState));
export const isReadyToMerge = (pr) =>
  isOpen(pr) &&
  !pr.isDraft &&
  pr.statusReady !== false &&
  pr.readyToMerge === true;
export const hasUnaddressedComments = (pr) =>
  !!(pr.unaddressedComments ?? pr.feedbackFingerprint);
export const hasPreparedReview = (job) =>
  !!(
    (job?.kind === 'review' && job.status === 'pending') ||
    job?.pendingTasks?.some((task) => task.kind === 'review')
  );

export function queueForPull(pr, job) {
  if (!isOpen(pr)) return 'closed';
  if (isMine(pr)) return 'mine';
  if (
    pr.pendingReview ||
    pr.pendingResponse ||
    (job?.kind === 'review' && isJobBusy(job)) ||
    hasPreparedReview(job)
  )
    return 'in-review';
  if (
    (pr.roles?.includes('review') || pr.roles?.includes('assigned')) &&
    (!wasReviewed(pr) || pr.reviewedCurrentHead === false)
  )
    return 'needs-review';
  return 'other';
}

export function matchesPullFilter(pr, filter, job) {
  switch (filter) {
    case 'ready':
      return isReadyToMerge(pr);
    case 'pending':
      return !!pr.pendingReview || hasPreparedReview(job);
    case 'reply':
      return !!pr.pendingResponse;
    case 'feedback':
      return isMine(pr) && hasUnaddressedComments(pr);
    case 'failing':
      return hasFailedChecks(pr);
    case 'conflicts':
      return hasConflict(pr);
    case 'draft':
      return !!pr.isDraft;
    default:
      return true;
  }
}

export function needsFocus(pr, job) {
  if (!isOpen(pr) || job?.status === 'pending') return false;
  if (isJobBusy(job)) return true;
  return (
    queueForPull(pr, job) === 'needs-review' ||
    !!pr.pendingReview ||
    !!pr.pendingResponse ||
    (isMine(pr) &&
      (isReadyToMerge(pr) ||
        hasUnaddressedComments(pr) ||
        hasFailedChecks(pr) ||
        hasConflict(pr)))
  );
}

export function pullUrl(value) {
  try {
    const url = new URL(value);
    const match =
      /^\/([\w.-]+)\/([\w.-]+)\/pull\/([0-9]+)(?:\/(?:files|commits|checks|changes))?\/?$/.exec(
        url.pathname,
      );
    if (
      !match ||
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password
    )
      return '';
    const [, owner, repository, number] = match;
    const id = Number(number);
    if (!Number.isSafeInteger(id) || id < 1) return '';
    return `${url.origin}/${owner}/${repository}/pull/${id}`;
  } catch {
    return '';
  }
}

export const pullUrlKey = (value) => pullUrl(value).toLowerCase();
