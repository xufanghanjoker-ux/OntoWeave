export function createRecordStore() {
  let records = new Map();
  let active = false;
  const key = (kind, id) => JSON.stringify([kind, id]);
  return {
    getRecord(kind, id) {
      return structuredClone(records.get(key(kind, id))?.value ?? null);
    },
    putRecord(kind, id, value) {
      records.set(key(kind, id), {kind, value: structuredClone(value)});
      return value;
    },
    listRecords(kind) {
      return [...records.values()].filter(row => row.kind === kind).map(row => structuredClone(row.value));
    },
    transaction(action) {
      if (active) return action();
      const previous = records;
      records = new Map(previous);
      active = true;
      try {
        return action();
      } catch (error) {
        records = previous;
        throw error;
      } finally {
        active = false;
      }
    },
  };
}
