import { createServer } from "node:http";
import assert from "node:assert/strict";

const host = "127.0.0.1";
const port = 4173;
const account = "qa@example.test";
const password = process.env.AI_QA_FIXTURE_PASSWORD;

if (password === undefined || password.length === 0) {
  throw new Error("AI_QA_FIXTURE_PASSWORD is required");
}

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>AI QA login fixture</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; }
      form, main { display: grid; gap: 1rem; }
      label { display: grid; gap: .25rem; }
      [data-testid="login-error"] { color: #a40000; }
    </style>
  </head>
  <body>
    <div id="app">
      <form data-testid="login-form">
        <h1>Sign in</h1>
        <label>Email <input data-testid="login-email" name="email" type="email" autocomplete="username" required></label>
        <label>Password <input data-testid="login-password" name="password" type="password" autocomplete="current-password" required></label>
        <button data-testid="login-submit" type="submit">Sign in</button>
      </form>
    </div>
    <template id="authenticated-template">
      <main data-testid="authenticated-home">
        <h1>Authenticated home</h1>
        <p>Current account: <strong data-testid="current-account"></strong></p>
      </main>
    </template>
    <script>
      const app = document.querySelector('#app');
      const form = document.querySelector('[data-testid="login-form"]');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        document.querySelector('[data-testid="login-error"]')?.remove();
        const values = new FormData(form);
        const response = await fetch('/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: values.get('email'), password: values.get('password') }),
        });
        const result = await response.json();
        if (!result.ok) {
          const error = document.createElement('p');
          error.dataset.testid = 'login-error';
          error.textContent = 'Invalid credentials';
          form.append(error);
          return;
        }
        const home = document.querySelector('#authenticated-template').content.cloneNode(true);
        home.querySelector('[data-testid="current-account"]').textContent = result.account;
        app.replaceChildren(home);
        history.pushState({}, '', '/home');
      });
    </script>
  </body>
</html>
`;

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function authenticate(supplied) {
  return supplied?.email === account && supplied?.password === password;
}

if (process.argv.includes("--self-test")) {
  assert.equal(authenticate({ email: account, password }), true);
  assert.equal(authenticate({ email: account, password: "incorrect" }), false);
  assert.match(html, /data-testid="login-submit"/);
  assert.match(html, /data-testid="authenticated-home"/);
  assert.match(html, /data-testid="current-account"/);
  assert.equal(html.includes(password), false);
  process.stdout.write("fixture self-test ok\n");
  process.exit(0);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${String(port)}`);
  if (request.method === "GET" && url.pathname === "/health") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ok");
    return;
  }
  if (request.method === "POST" && url.pathname === "/session") {
    const supplied = await readJson(request);
    const authenticated = authenticate(supplied);
    response.writeHead(authenticated ? 200 : 401, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(
      JSON.stringify(authenticated ? { ok: true, account } : { ok: false }),
    );
    return;
  }
  if (
    request.method === "GET" &&
    ["/", "/login", "/home"].includes(url.pathname)
  ) {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(html);
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found");
});

server.listen(port, host, () => {
  process.stdout.write(`http://${host}:${String(port)}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
