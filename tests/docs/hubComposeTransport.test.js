'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const publishedOnLoopback = '${JIRAN_BIND_HOST:-127.0.0.1}';

for (const name of ['docker-compose.yml', 'docker-compose.external-db.yml']) {
  test(`${name} publishes on loopback while the container listens on all interfaces`, () => {
    const text = read(name);
    // Docker DNATs the published port to the container address, so a loopback
    // listener inside the container is unreachable; the publish address is what
    // decides exposure.
    assert.match(text, /^\s+TOKEN_MONITOR_HOST: 0\.0\.0\.0$/m);
    assert.ok(text.includes(`- "${publishedOnLoopback}:\${TOKEN_MONITOR_PORT:-\${JIRAN_PORT:-17321}}:17321"`));
    assert.match(text, /^\s+TOKEN_MONITOR_ALLOW_INSECURE_HTTP: '1'$/m);
    assert.equal(text.includes('${JIRAN_ALLOW_INSECURE_HTTP:-0}'), false);
  });
}

test('the quick start is loopback-only and documents every remote transport choice', () => {
  const guide = read('docs/hub-compose.md');
  const quickStart = guide.split('## Choose a remote-access transport')[0];
  assert.ok(quickStart.includes('curl http://127.0.0.1:17321/api/health'));
  assert.equal(quickStart.includes('JIRAN_ALLOW_INSECURE_HTTP=1'), false);
  assert.ok(guide.includes('Same-host HTTPS reverse proxy'));
  assert.ok(guide.includes('Direct Hub TLS'));
  assert.ok(guide.includes('TOKEN_MONITOR_TLS_CERT=/certs/hub.crt'));
  assert.ok(guide.includes('Trusted LAN/VPN plaintext HTTP'));
  assert.ok(guide.includes('JIRAN_BIND_HOST=0.0.0.0'));
  assert.ok(guide.includes('JIRAN_ALLOW_INSECURE_HTTP=1'));
  assert.ok(guide.includes('insecure_hub_transport'));
  assert.ok(read('.env.example').includes('JIRAN_BIND_HOST=127.0.0.1'));
});

test('website and WSL instructions do not imply an exposed default port', () => {
  const site = read('website/src/data/product.ts');
  assert.ok(site.includes('Publishes to 127.0.0.1 only'));
  assert.ok(site.includes('curl http://127.0.0.1:17321/api/health'));
  for (const name of ['docs/wsl-sqlite-setup.md', 'docs/wsl-sqlite-setup.zh-CN.md', 'docs/hermes-wsl-setup.md']) {
    const text = read(name);
    assert.ok(text.includes('JIRAN_BIND_HOST=0.0.0.0'), name);
    assert.ok(text.includes('JIRAN_ALLOW_INSECURE_HTTP=1'), name);
  }
});

for (const name of ['docker-compose.yml', 'docker-compose.external-db.yml']) {
  test(`${name} maps the credential keyring and its legacy names`, () => {
    const text = read(name);
    // A documented JIRAN_* variable that Compose never forwards is not a setting.
    assert.ok(
      text.includes('TOKEN_MONITOR_HUB_CREDENTIAL_KEY: ${TOKEN_MONITOR_HUB_CREDENTIAL_KEY:-${JIRAN_HUB_CREDENTIAL_KEY:-}}'),
      `${name}: current credential key mapping`
    );
    assert.ok(
      text.includes('TOKEN_MONITOR_HUB_PREVIOUS_CREDENTIAL_KEYS: ${TOKEN_MONITOR_HUB_PREVIOUS_CREDENTIAL_KEYS:-${JIRAN_HUB_PREVIOUS_CREDENTIAL_KEYS:-}}'),
      `${name}: previous-key rotation mapping`
    );
  });
}
