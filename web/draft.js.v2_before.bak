// IndexedDB keeps the original file and form together across reloads.
function access(mode, operation) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("pixel2plot", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("drafts");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction("drafts", mode);
      const request = operation(transaction.objectStore("drafts"));
      transaction.oncomplete = () => { db.close(); resolve(request.result); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  });
}

export const readDraft = (user) => access("readonly", (store) => store.get(user));
export const writeDraft = (user, draft) => access("readwrite", (store) => store.put(draft, user));
export const deleteDraft = (user) => access("readwrite", (store) => store.delete(user));
