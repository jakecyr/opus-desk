// Coalesce edits and serialize writes so an older request cannot overwrite a newer edit.
export function createAutosave(save, onStatus, delay = 500) {
  let pending = {},
    timer = null,
    running = false,
    disposed = false;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(flush, delay);
  };
  async function flush() {
    clearTimeout(timer);
    timer = null;
    if (running || !Object.keys(pending).length) return;
    const patch = pending;
    pending = {};
    running = true;
    onStatus('saving');
    let failed = false;
    try {
      await save(patch);
    } catch (e) {
      pending = { ...patch, ...pending };
      failed = true;
      onStatus('error', e.message);
    } finally {
      running = false;
      if (!failed) {
        if (Object.keys(pending).length) {
          if (disposed) void flush();
          else schedule();
        } else onStatus('saved');
      }
    }
  }
  return {
    change(patch) {
      pending = { ...pending, ...patch };
      onStatus('pending');
      schedule();
    },
    flush,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      void flush();
    },
    get dirty() {
      return running || !!Object.keys(pending).length;
    },
  };
}
