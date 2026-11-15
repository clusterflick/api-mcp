import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

/**
 * The few pages the Worker shows a reader while their assistant signs in:
 * asking whether to allow it, and saying why it can't. Plain HTML on the
 * site's colours, with no script: nothing here needs any, and a client's name
 * is the client's to choose, so it's escaped wherever it appears.
 */

export const escape = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** The brand guide's colours (clusterflick/branding), as api-profiles' card. */
const STYLE = `
:root { color-scheme: dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center;
  background: #010013; color: #ffffff; font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 480px; margin: 24px 16px; padding: 28px;
  border: 1px solid rgba(241, 40, 105, 0.4); border-radius: 12px;
  background: rgba(241, 40, 105, 0.08); }
h1 { margin: 0 0 12px; font-size: 22px; line-height: 1.3; }
p { margin: 0 0 12px; color: #d8d8e0; }
strong { color: #ffffff; }
.warning { color: #fade05; }
.actions { display: flex; gap: 12px; margin-top: 20px; flex-wrap: wrap; }
button, a.button { font: inherit; padding: 10px 18px; border-radius: 8px;
  border: 1px solid #f12869; cursor: pointer; text-decoration: none; }
.allow { background: #f12869; color: #ffffff; }
.deny, a.button { background: transparent; color: #ffffff; }
`;

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)} · Clusterflick</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

const HTML = { "Content-Type": "text/html; charset=utf-8" };

/**
 * Whether to let this assistant search as the reader: what MCP's security
 * guidance says a consent page must show — the client's name, where access
 * goes, a warning when that's this computer, and a CIMD client's domain.
 */
export function consentPage(details: ConsentDescription, handle: string) {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `It's published by <strong>${escape(details.clientDomain)}</strong>.`
    : "It registered itself, so its name isn't verified.";
  return page(
    `Connect ${details.clientName}`,
    `<h1>Let <strong>${name}</strong> search Clusterflick for you?</h1>
<p>${origin} If you allow it, you'll sign in to Clusterflick next, and access goes to ${
      // An app on this computer (Claude Code, say) receives it at a local
      // address: said in words, with the hostname kept, as MCP requires.
      details.redirectIsLoopback
        ? `<strong>an app on this computer</strong> (${escape(details.redirectHost)}).</p>
<p class="warning">Only continue if you started connecting from it just now.</p>`
        : `<strong>${escape(details.redirectHost)}</strong>.</p>`
    }
<p>It will be able to search London's screenings, films and venues. It won't see your lists or change anything.</p>
<form method="post">
<input type="hidden" name="handle" value="${escape(handle)}">
<div class="actions">
<button class="allow" name="decision" value="allow">Allow</button>
<button class="deny" name="decision" value="deny">Deny</button>
</div>
</form>`,
  );
}

/** A page saying what happened, with a way on when there is one. */
export function noticePage(
  title: string,
  message: string,
  link?: { href: string; label: string },
) {
  return page(
    title,
    `<h1>${escape(title)}</h1>
<p>${escape(message)}</p>
${
  link
    ? `<div class="actions"><a class="button" href="${escape(link.href)}">${escape(link.label)}</a></div>`
    : ""
}`,
  );
}

export function htmlResponse(
  body: string,
  { status = 200, headers }: { status?: number; headers?: Headers } = {},
) {
  const all = new Headers(headers);
  for (const [key, value] of Object.entries(HTML)) all.set(key, value);
  // None of these is ever worth caching, and none may be framed: the
  // consent page's own headers say so too. No `form-action`: browsers hold
  // the redirect after a post to it as well, and the consent form's answer
  // is a redirect to the site, or back to the assistant, wherever that is.
  all.set("Cache-Control", "no-store");
  all.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  );
  all.set("X-Frame-Options", "DENY");
  return new Response(body, { status, headers: all });
}
