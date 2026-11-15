import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { exportPKCS8, generateKeyPair } from "jose";
import { defineConfig } from "vitest/config";

/**
 * A service account made up for the tests, as api-profiles' are: the Worker
 * signs Google token requests with it, which the tests' fake Google accepts.
 */
const { privateKey } = await generateKeyPair("RS256", { extractable: true });
const SERVICE_ACCOUNT = JSON.stringify({
  type: "service_account",
  client_email: "api-mcp@clusterflick-com.iam.gserviceaccount.com",
  private_key: await exportPKCS8(privateKey),
  private_key_id: "test-key",
});

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Every value pinned here, so a `.dev.vars` written for `wrangler dev`
      // (localhost addresses, the real key) never reaches the tests.
      miniflare: {
        bindings: {
          FIREBASE_SERVICE_ACCOUNT: SERVICE_ACCOUNT,
          SITE_ORIGIN: "https://clusterflick.com",
          MCP_ORIGIN: "https://mcp.clusterflick.com",
          CONNECT_URL: "https://clusterflick.com/connect/",
        },
      },
    }),
  ],
});
