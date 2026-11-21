export const isJobBusy = (job) =>
  ['starting', 'running', 'collecting', 'publishing'].includes(job?.status);
