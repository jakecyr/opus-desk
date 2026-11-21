import { createHash } from 'node:crypto';
import { getAutoActionMode } from './review-policy.js';

const digest = (value) =>
  createHash('sha256').update(value).digest('hex').slice(0, 20);

export function autoCandidates(cache, known = {}, settings = {}, tasks = {}) {
  const candidates = [];
  const published = Object.values(tasks).filter(
    (task) =>
      task.auto &&
      task.type === 'code' &&
      (task.status === 'published' || task.automaticEffect === 'attempted'),
  );
  for (const pr of cache.prs || []) {
    const { url, headRefOid: head, baseRefOid: base } = pr;
    if (!pr.statusReady || pr.state !== 'OPEN' || pr.isDraft || !head) continue;
    const choices = [];
    function add(action, revision, kind = action, signal) {
      const mode = getAutoActionMode(settings, action);
      const key = [action, url, revision].join(':');
      if (mode !== 'off' && !known[key])
        choices.push({ key, url, action, kind, mode, head, base, signal });
    }
    if (pr.roles?.includes('authored')) {
      const previousFix = (kind) =>
        published.find(
          (task) =>
            task.kind === kind && task.url === url && task.head === head,
        );
      if (pr.mergeable === 'CONFLICTING') {
        if (base) add('conflicts', head + ':' + base);
      } else {
        if (
          !previousFix('ci') &&
          (pr.checkState === 'FAILURE' || pr.failedChecks?.length)
        ) {
          // Reruns and changes to failed check names do not restart an attempt.
          add('ci', head);
        }
        if (
          pr.feedbackFingerprint &&
          previousFix('comments')?.signal !== pr.feedbackFingerprint
        ) {
          add(
            'comments',
            head + ':' + digest(pr.feedbackFingerprint),
            'comments',
            pr.feedbackFingerprint,
          );
        }
      }
    } else if (!pr.pendingReview) {
      const requested = pr.roles?.includes('review');
      if (
        pr.responseFingerprint ||
        (requested && pr.reviewedByMe && !pr.reviewedCurrentHead)
      ) {
        const revision = pr.responseFingerprint
          ? head + ':' + digest(pr.responseFingerprint)
          : head;
        add('rereview', revision, 'review');
      } else if (requested && !pr.reviewedByMe) {
        add('review', head);
      }
    }
    if (choices.length) candidates.push(choices[0]);
  }
  // GitHub state determines eligibility. A failure for one revision must not
  // starve later PRs or schedule the same work over and over.
  return candidates;
}

export function automaticEffect(task, enabled, settings) {
  if (
    !task.auto ||
    !enabled ||
    task.status !== 'pending' ||
    task.automaticEffect
  )
    return null;
  const current = getAutoActionMode(settings, task.action);
  if (current === 'off') return null;
  if (task.kind === 'review' && task.type === 'review-artifact') {
    if (task.requestedMode === 'publish' && current === 'publish')
      return 'publish';
    if (['draft', 'publish'].includes(task.requestedMode)) return 'draft';
  }
  if (
    task.type === 'code' &&
    task.tested &&
    task.requestedMode === 'publish' &&
    current === 'publish'
  )
    return 'publish';
  return null;
}
