/**
 * Standalone Quran Foundation credential check.
 *
 *   node --env-file=.env.local scripts/check-credentials.mjs
 *
 * Runs the documented Client Credentials flow against BOTH environments so a
 * prelive/production credential mismatch is obvious. Never prints the secret.
 */
const ENVIRONMENTS = {
  prelive: {
    auth: "https://prelive-oauth2.quran.foundation",
    api: "https://apis-prelive.quran.foundation",
  },
  production: {
    auth: "https://oauth2.quran.foundation",
    api: "https://apis.quran.foundation",
  },
};

const clientId = process.env.QF_CLIENT_ID?.trim();
const clientSecret = process.env.QF_CLIENT_SECRET?.trim();
const declared = (process.env.QF_ENV ?? "prelive").trim().toLowerCase();

if (!clientId || !clientSecret) {
  console.error("QF_CLIENT_ID / QF_CLIENT_SECRET are not set. Run with: node --env-file=.env.local scripts/check-credentials.mjs");
  process.exit(1);
}

console.log(`client_id      : ${clientId.slice(0, 8)}… (${clientId.length} chars)`);
console.log(`client_secret  : ${"*".repeat(8)} (${clientSecret.length} chars)`);
console.log(`QF_ENV declared: ${declared}`);
console.log();

async function tryEnvironment(name, { auth, api }) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  let token;
  try {
    const response = await fetch(`${auth}/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "content" }),
    });
    const body = await response.text();
    if (!response.ok) {
      console.log(`${name.padEnd(10)} token  FAIL ${response.status}  ${body.slice(0, 160)}`);
      return;
    }
    token = JSON.parse(body).access_token;
    console.log(`${name.padEnd(10)} token  OK`);
  } catch (error) {
    console.log(`${name.padEnd(10)} token  NETWORK ERROR  ${error.message}`);
    return;
  }

  // A token alone is not proof of access; confirm the Content scope works too.
  try {
    const response = await fetch(`${api}/content/api/v4/chapters?language=en`, {
      headers: { "x-auth-token": token, "x-client-id": clientId, Accept: "application/json" },
    });
    const body = await response.text();
    if (!response.ok) {
      console.log(`${name.padEnd(10)} content FAIL ${response.status}  ${body.slice(0, 160)}`);
      return;
    }
    const count = JSON.parse(body).chapters?.length ?? 0;
    console.log(`${name.padEnd(10)} content OK   ${count} chapters`);
  } catch (error) {
    console.log(`${name.padEnd(10)} content NETWORK ERROR  ${error.message}`);
  }

  // The search scope is granted separately and is optional for the game.
  try {
    const response = await fetch(`${auth}/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "search" }),
    });
    console.log(`${name.padEnd(10)} search ${response.ok ? "OK" : `FAIL ${response.status} (autocomplete falls back to the local catalog)`}`);
  } catch (error) {
    console.log(`${name.padEnd(10)} search NETWORK ERROR  ${error.message}`);
  }
}

for (const [name, config] of Object.entries(ENVIRONMENTS)) {
  await tryEnvironment(name, config);
  console.log();
}

console.log("If one environment succeeds and the other fails, set QF_ENV to the one that works.");
console.log("If both fail with invalid_client, regenerate the secret in the Developer Console");
console.log("(Backend/server apps show the client_secret once, at creation).");
