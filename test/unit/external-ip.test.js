/**
 * External IP Resolver Tests
 *
 * Covers: getExternalIp() caching (fresh, stale, corrupt, forceRefresh),
 * fetchExternalIp() failover and error handling, IP parsing via local
 * HTTP server, response size cap, and bad HTTP status handling.
 *
 * All network tests use a local HTTP server — no real external calls.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

module.exports = function (test, assert, helpers) {

  // ── Helper: start a local HTTP server returning controlled responses ──

  function startMockIpServer(handler) {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        resolve({
          url: `http://127.0.0.1:${port}/ip`,
          port,
          server,
          close() {
            return new Promise((res) => server.close(res));
          }
        });
      });
    });
  }

  function freshModule() {
    delete require.cache[require.resolve('../../src/lib/external-ip')];
    return require('../../src/lib/external-ip');
  }

  // ── getExternalIp: fresh cache ─────────────────────────────────────

  test('getExternalIp returns cached IP when cache is fresh', async () => {
    const { dir, cleanup } = helpers.tmpConfigDir('ext-ip');
    try {
      const cacheFile = path.join(dir, 'a2a-external-ip.json');
      const checkedAt = new Date(1700000000000).toISOString();
      fs.writeFileSync(cacheFile, JSON.stringify({
        ip: '93.184.216.34',
        checked_at: checkedAt,
        source: 'https://ifconfig.me/ip'
      }));

      const { getExternalIp } = freshModule();
      const result = await getExternalIp({
        cacheFile,
        ttlMs: 60 * 60 * 1000,
        nowMs: 1700000000000 + 1000 // 1 second after check
      });

      assert.equal(result.ip, '93.184.216.34');
      assert.equal(result.fromCache, true);
      assert.equal(result.stale, false);
      assert.equal(result.checkedAt, checkedAt);
    } finally {
      cleanup();
    }
  });

  // ── getExternalIp: stale cache with fetch failure ──────────────────

  test('getExternalIp returns stale cache when fetch fails', async () => {
    const { dir, cleanup } = helpers.tmpConfigDir('ext-ip');
    try {
      const cacheFile = path.join(dir, 'a2a-external-ip.json');
      const checkedAt = new Date(1700000000000).toISOString();
      fs.writeFileSync(cacheFile, JSON.stringify({
        ip: '93.184.216.34',
        checked_at: checkedAt,
        source: 'https://ifconfig.me/ip'
      }));

      // Start a mock server that always 500s
      const mock = await startMockIpServer((_req, res) => {
        res.writeHead(500);
        res.end('Internal Server Error');
      });

      try {
        const { getExternalIp } = freshModule();
        const result = await getExternalIp({
          cacheFile,
          ttlMs: 1000,
          nowMs: 1700000000000 + 5000, // 5 seconds after check, TTL=1s => stale
          services: [mock.url],
          timeoutMs: 2000
        });

        assert.equal(result.ip, '93.184.216.34');
        assert.equal(result.fromCache, true);
        assert.equal(result.stale, true);
        assert.ok(result.error, 'Expected error field on stale result');
      } finally {
        await mock.close();
      }
    } finally {
      cleanup();
    }
  });

  // ── getExternalIp: no cache (fresh fetch) ──────────────────────────

  test('getExternalIp fetches and writes cache when no cache exists', async () => {
    const { dir, cleanup } = helpers.tmpConfigDir('ext-ip');
    try {
      const cacheFile = path.join(dir, 'a2a-external-ip.json');

      const mock = await startMockIpServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('198.51.100.7\n');
      });

      try {
        const { getExternalIp } = freshModule();
        const result = await getExternalIp({
          cacheFile,
          services: [mock.url],
          timeoutMs: 2000,
          nowMs: 1700000000000
        });

        assert.equal(result.ip, '198.51.100.7');
        assert.equal(result.fromCache, false);
        assert.equal(result.stale, false);
        assert.equal(result.source, mock.url);

        // Verify cache file was written
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        assert.equal(cached.ip, '198.51.100.7');
        assert.ok(cached.checked_at);
        assert.equal(cached.source, mock.url);
      } finally {
        await mock.close();
      }
    } finally {
      cleanup();
    }
  });

  // ── getExternalIp: forceRefresh bypasses fresh cache ───────────────

  test('getExternalIp with forceRefresh bypasses fresh cache', async () => {
    const { dir, cleanup } = helpers.tmpConfigDir('ext-ip');
    try {
      const cacheFile = path.join(dir, 'a2a-external-ip.json');
      fs.writeFileSync(cacheFile, JSON.stringify({
        ip: '93.184.216.34',
        checked_at: new Date(1700000000000).toISOString(),
        source: 'https://ifconfig.me/ip'
      }));

      const mock = await startMockIpServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('203.0.113.42\n');
      });

      try {
        const { getExternalIp } = freshModule();
        const result = await getExternalIp({
          cacheFile,
          ttlMs: 60 * 60 * 1000,
          nowMs: 1700000000000 + 1000, // within TTL
          services: [mock.url],
          timeoutMs: 2000,
          forceRefresh: true
        });

        assert.equal(result.ip, '203.0.113.42');
        assert.equal(result.fromCache, false);
        assert.equal(result.stale, false);
      } finally {
        await mock.close();
      }
    } finally {
      cleanup();
    }
  });

  // ── getExternalIp: corrupt cache falls through to fetch ────────────

  test('getExternalIp with corrupt cache file gracefully fetches', async () => {
    const { dir, cleanup } = helpers.tmpConfigDir('ext-ip');
    try {
      const cacheFile = path.join(dir, 'a2a-external-ip.json');
      fs.writeFileSync(cacheFile, '{{not valid json!!!');

      const mock = await startMockIpServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('198.51.100.99\n');
      });

      try {
        const { getExternalIp } = freshModule();
        const result = await getExternalIp({
          cacheFile,
          services: [mock.url],
          timeoutMs: 2000,
          nowMs: 1700000000000
        });

        assert.equal(result.ip, '198.51.100.99');
        assert.equal(result.fromCache, false);
      } finally {
        await mock.close();
      }
    } finally {
      cleanup();
    }
  });

  // ── getExternalIp: TTL boundary ────────────────────────────────────

  test('getExternalIp cache at exact TTL boundary is still fresh', async () => {
    const { dir, cleanup } = helpers.tmpConfigDir('ext-ip');
    try {
      const cacheFile = path.join(dir, 'a2a-external-ip.json');
      const checkTime = 1700000000000;
      const ttlMs = 60000;
      fs.writeFileSync(cacheFile, JSON.stringify({
        ip: '10.0.0.1',
        checked_at: new Date(checkTime).toISOString(),
        source: 'test'
      }));

      const { getExternalIp } = freshModule();
      // nowMs exactly at TTL boundary (age == ttl)
      const result = await getExternalIp({
        cacheFile,
        ttlMs,
        nowMs: checkTime + ttlMs
      });

      assert.equal(result.ip, '10.0.0.1');
      assert.equal(result.fromCache, true);
      assert.equal(result.stale, false);
    } finally {
      cleanup();
    }
  });

  // ── getExternalIp: no cache + all services fail → ip: null ─────────

  test('getExternalIp returns ip null when no cache and all services fail', async () => {
    const { dir, cleanup } = helpers.tmpConfigDir('ext-ip');
    try {
      const cacheFile = path.join(dir, 'a2a-external-ip.json');
      // No cache file exists

      const mock = await startMockIpServer((_req, res) => {
        res.writeHead(500);
        res.end('fail');
      });

      try {
        const { getExternalIp } = freshModule();
        const result = await getExternalIp({
          cacheFile,
          services: [mock.url],
          timeoutMs: 2000,
          nowMs: 1700000000000
        });

        assert.equal(result.ip, null);
        assert.ok(result.error, 'Expected error field when all services fail');
      } finally {
        await mock.close();
      }
    } finally {
      cleanup();
    }
  });

  // ── fetchExternalIp: all services fail throws with attempts ────────

  test('fetchExternalIp throws when all services fail', async () => {
    const mock = await startMockIpServer((_req, res) => {
      res.writeHead(500);
      res.end('error');
    });

    try {
      const { fetchExternalIp } = freshModule();
      let thrownErr;
      try {
        await fetchExternalIp({ services: [mock.url], timeoutMs: 2000 });
      } catch (err) {
        thrownErr = err;
      }

      assert.ok(thrownErr, 'Expected fetchExternalIp to throw');
      assert.ok(thrownErr.message.includes('external_ip_unavailable'));
      assert.ok(Array.isArray(thrownErr.attempts), 'Expected attempts array');
      assert.equal(thrownErr.attempts.length, 1);
      assert.equal(thrownErr.attempts[0].ok, false);
    } finally {
      await mock.close();
    }
  });

  // ── fetchExternalIp: failover from first to second ─────────────────

  test('fetchExternalIp fails over from bad service to good service', async () => {
    let requestCount = 0;
    const mock = await startMockIpServer((_req, res) => {
      requestCount++;
      if (requestCount === 1) {
        res.writeHead(500);
        res.end('down');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('192.0.2.50\n');
      }
    });

    try {
      const { fetchExternalIp } = freshModule();
      // Point both "services" at the same server — it returns 500 first, then 200
      const result = await fetchExternalIp({
        services: [mock.url + '?svc=1', mock.url + '?svc=2'],
        timeoutMs: 2000
      });

      assert.equal(result.ip, '192.0.2.50');
      assert.equal(result.attempts.length, 2);
      assert.equal(result.attempts[0].ok, false);
      assert.equal(result.attempts[1].ok, true);
    } finally {
      await mock.close();
    }
  });

  // ── fetchExternalIp: bad HTTP status ───────────────────────────────

  test('fetchExternalIp treats non-2xx as failure', async () => {
    const mock = await startMockIpServer((_req, res) => {
      res.writeHead(403);
      res.end('Forbidden');
    });

    try {
      const { fetchExternalIp } = freshModule();
      let thrownErr;
      try {
        await fetchExternalIp({ services: [mock.url], timeoutMs: 2000 });
      } catch (err) {
        thrownErr = err;
      }

      assert.ok(thrownErr, 'Expected fetchExternalIp to throw on 403');
      assert.ok(Array.isArray(thrownErr.attempts));
      assert.equal(thrownErr.attempts[0].ok, false);
      assert.ok(thrownErr.attempts[0].error.includes('bad_status_403'));
    } finally {
      await mock.close();
    }
  });

  // ── fetchExternalIp: response too large ────────────────────────────

  test('fetchExternalIp rejects responses exceeding 4KB', async () => {
    const mock = await startMockIpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      // Stream data in chunks to trigger the >4096 check in the 'data' handler.
      // req.destroy() emits an error on the socket — absorb it via server-side
      // 'close' handling by writing chunks with a small delay.
      let written = 0;
      const chunk = 'X'.repeat(1024);
      const interval = setInterval(() => {
        if (written >= 6144) {
          clearInterval(interval);
          res.end();
          return;
        }
        res.write(chunk);
        written += chunk.length;
      }, 5);
      // Clean up if the client disconnects early (expected)
      res.on('close', () => clearInterval(interval));
    });

    try {
      const { fetchExternalIp } = freshModule();
      let thrownErr;
      try {
        await fetchExternalIp({ services: [mock.url], timeoutMs: 5000 });
      } catch (err) {
        thrownErr = err;
      }

      assert.ok(thrownErr, 'Expected fetchExternalIp to throw on oversized response');
      assert.ok(Array.isArray(thrownErr.attempts));
      assert.equal(thrownErr.attempts[0].ok, false);
    } finally {
      await mock.close();
    }
  });

  // ── IP parsing (indirect via fetchExternalIp) ──────────────────────

  test('parseIp handles IPv4 with trailing whitespace', async () => {
    const mock = await startMockIpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('  203.0.113.5  \n');
    });

    try {
      const { fetchExternalIp } = freshModule();
      const result = await fetchExternalIp({
        services: [mock.url],
        timeoutMs: 2000
      });
      assert.equal(result.ip, '203.0.113.5');
    } finally {
      await mock.close();
    }
  });

  test('parseIp handles IPv6 address', async () => {
    const mock = await startMockIpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('2001:db8::1\n');
    });

    try {
      const { fetchExternalIp } = freshModule();
      const result = await fetchExternalIp({
        services: [mock.url],
        timeoutMs: 2000
      });
      assert.equal(result.ip, '2001:db8::1');
    } finally {
      await mock.close();
    }
  });

  test('parseIp strips surrounding quotes', async () => {
    const mock = await startMockIpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('"198.51.100.1"\n');
    });

    try {
      const { fetchExternalIp } = freshModule();
      const result = await fetchExternalIp({
        services: [mock.url],
        timeoutMs: 2000
      });
      assert.equal(result.ip, '198.51.100.1');
    } finally {
      await mock.close();
    }
  });

  test('parseIp rejects non-IP text', async () => {
    const mock = await startMockIpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('not-an-ip-address\n');
    });

    try {
      const { fetchExternalIp } = freshModule();
      let thrownErr;
      try {
        await fetchExternalIp({ services: [mock.url], timeoutMs: 2000 });
      } catch (err) {
        thrownErr = err;
      }
      assert.ok(thrownErr, 'Expected rejection for non-IP response');
      assert.ok(thrownErr.attempts[0].error.includes('invalid_ip'));
    } finally {
      await mock.close();
    }
  });
};
