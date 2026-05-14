import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../lib/dataDir.js";
import { machineIdSync } from 'node-machine-id';

const MACHINE_ID_SALT_PATH = path.join(DATA_DIR, "machine_id_salt");

function loadMachineIdSalt() {
  if (process.env.MACHINE_ID_SALT) return process.env.MACHINE_ID_SALT;

  if (fs.existsSync(MACHINE_ID_SALT_PATH)) {
    return fs.readFileSync(MACHINE_ID_SALT_PATH, "utf8").trim();
  }

  const newSalt = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MACHINE_ID_SALT_PATH, newSalt, "utf8");
  console.info("[MachineId] Generated new salt and saved to", MACHINE_ID_SALT_PATH);
  return newSalt;
}

const DEFAULT_SALT = loadMachineIdSalt();

/**
 * Get consistent machine ID using node-machine-id with salt
 * This ensures the same physical machine gets the same ID across runs
 * 
 * @param {string} salt - Optional salt to use (defaults to persisted salt)
 * @returns {Promise<string>} Machine ID (16-character base32)
 */
export async function getConsistentMachineId(salt = null) {
  const saltValue = salt || DEFAULT_SALT;
  try {
    const rawMachineId = machineIdSync();
    const hashedMachineId = crypto.createHash('sha256').update(rawMachineId + saltValue).digest('hex');
    return hashedMachineId.substring(0, 16);
  } catch (error) {
    console.log('Error getting machine ID:', error);
    return crypto.randomUUID ? crypto.randomUUID() : 
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
  }
}

/**
 * Get raw machine ID without hashing (for debugging purposes)
 * @returns {Promise<string>} Raw machine ID
 */
export async function getRawMachineId() {
  // For server-side, use raw node-machine-id
  try {
    return machineIdSync();
  } catch (error) {
    console.log('Error getting raw machine ID:', error);
    // Fallback to random ID if node-machine-id fails
    return crypto.randomUUID ? crypto.randomUUID() : 
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
  }
}

/**
 * Check if we're running in browser or server environment
 * @returns {boolean} True if in browser, false if in server
 */
export function isBrowser() {
  return typeof window !== 'undefined';
}
