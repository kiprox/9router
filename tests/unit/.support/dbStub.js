// Minimal in-memory stand-in for "@/lib/db" used by cline-image-loader.mjs.
//
// The cline image adapter talks to the upstream through the real DefaultExecutor,
// whose import chain reaches the storage layer. These tests assert on the
// request/response mapping, so every accessor returns an empty result instead of
// opening DATA_DIR/db/data.sqlite. Never use this stub for a storage test.
export const getDb = () => ({});
export const isCloud = () => false;
export const initDb = async () => {};

export const getSettings = async () => ({});
export const updateSettings = async () => ({});
export const getProviderConnections = async () => [];
export const getProviderConnectionById = async () => null;
export const createProviderConnection = async () => ({});
export const updateProviderConnection = async () => ({});
export const deleteProviderConnection = async () => {};
export const getProviderNodes = async () => [];
export const getModelAliases = async () => ({});
export const getComboByName = async () => null;
export const getApiKeys = async () => [];

const dbStub = {
  getDb,
  isCloud,
  initDb,
  getSettings,
  updateSettings,
  getProviderConnections,
  getProviderConnectionById,
  createProviderConnection,
  updateProviderConnection,
  deleteProviderConnection,
  getProviderNodes,
  getModelAliases,
  getComboByName,
  getApiKeys,
};

export default dbStub;
