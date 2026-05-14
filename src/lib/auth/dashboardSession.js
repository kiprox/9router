import { SignJWT, jwtVerify } from "jose";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../dataDir.js";

const JWT_SECRET_PATH = path.join(DATA_DIR, "jwt_secret");

function loadOrGenerateJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

  if (fs.existsSync(JWT_SECRET_PATH)) {
    return fs.readFileSync(JWT_SECRET_PATH, "utf8").trim();
  }

  const newSecret = crypto.randomBytes(32).toString("hex");

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(JWT_SECRET_PATH, newSecret, "utf8");

  console.info("[Auth] Generated new JWT_SECRET and saved to", JWT_SECRET_PATH);
  return newSecret;
}

const jwtSecret = loadOrGenerateJwtSecret();
const SECRET = new TextEncoder().encode(jwtSecret);

export function shouldUseSecureCookie(request) {
  const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
  const forwardedProto = request?.headers?.get?.("x-forwarded-proto");
  const isHttpsRequest = forwardedProto === "https";
  return forceSecureCookie || isHttpsRequest;
}

export async function createDashboardAuthToken(claims = {}) {
  return new SignJWT({ authenticated: true, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(SECRET);
}

export async function verifyDashboardAuthToken(token) {
  if (!token) return false;
  try {
    await jwtVerify(token, SECRET);
    return true;
  } catch {
    return false;
  }
}

export async function getDashboardAuthSession(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SECRET);
    return payload;
  } catch {
    return null;
  }
}

export async function setDashboardAuthCookie(cookieStore, request, claims = {}) {
  const token = await createDashboardAuthToken(claims);
  cookieStore.set("auth_token", token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(request),
    sameSite: "lax",
    path: "/",
  });
}

export function clearDashboardAuthCookie(cookieStore) {
  cookieStore.delete("auth_token");
}
