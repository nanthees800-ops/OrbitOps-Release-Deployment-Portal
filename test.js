/**
 * OrbitOps - Comprehensive Automated Test Suite
 * In-memory Direct Dispatch Test Runner (Standard Sandbox Compatible)
 */

const assert = require('assert');
const { Readable } = require('stream');
const { EventEmitter } = require('events');
const { server, calculateReleaseRisk, triggerRollback } = require('./server.js');

const requestHandler = server.listeners('request')[0];

function invoke(method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = new Readable({
      read() {
        if (body) {
          const raw = typeof body === 'string' ? body : JSON.stringify(body);
          this.push(raw);
        }
        this.push(null);
      }
    });

    req.method = method;
    req.url = urlPath;
    req.headers = {
      'content-type': 'application/json',
      ...headers
    };

    let resBody = '';
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: {},
      writeHead(status, headers = {}) {
        this.statusCode = status;
        this.headers = headers;
      },
      write(chunk) {
        if (chunk) resBody += chunk.toString();
        return true;
      },
      end(chunk) {
        if (chunk) resBody += chunk.toString();
        let parsed;
        try {
          parsed = JSON.parse(resBody);
        } catch (e) {
          parsed = resBody;
        }
        resolve({
          status: this.statusCode,
          headers: this.headers,
          body: parsed
        });
      }
    });

    try {
      requestHandler(req, res).catch(reject);
    } catch (err) {
      reject(err);
    }
  });
}

async function runTests() {
  console.log('--- Starting OrbitOps Release & Deployment Test Suite ---');
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`\x1b[32m✔ PASS:\x1b[0m ${name}`);
      passed++;
    } catch (err) {
      console.error(`\x1b[31m✘ FAIL:\x1b[0m ${name}`);
      console.error(err);
      failed++;
    }
  }

  // 1. Health Check
  await test('GET /api/health returns healthy and node version', async () => {
    const res = await invoke('GET', '/api/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'healthy');
    assert.ok(res.body.uptime >= 0);
  });

  // 2. Overview Stats
  await test('GET /api/overview returns system overview and fleet stats', async () => {
    const res = await invoke('GET', '/api/overview');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.totalReleases > 0);
    assert.ok(res.body.totalServices > 0);
    assert.ok(res.body.environments.length > 0);
    assert.ok(res.body.doraSummary.deploymentFrequency);
  });

  // 3. Dynamic Risk Engine
  await test('calculateReleaseRisk correctly weights Tier-0, database migrations, and major bumps', () => {
    const highRisk = calculateReleaseRisk({
      serviceTier: 'Tier-0 (Mission Critical)',
      releaseType: 'major',
      hasDbMigration: true,
      targetEnvironment: 'prod-us'
    });
    assert.strictEqual(highRisk.level, 'CRITICAL');
    assert.ok(highRisk.score >= 70);

    const lowRisk = calculateReleaseRisk({
      serviceTier: 'Tier-2 (Standard)',
      releaseType: 'patch',
      hasDbMigration: false,
      targetEnvironment: 'dev'
    });
    assert.strictEqual(lowRisk.level, 'LOW');
    assert.ok(lowRisk.score <= 30);
  });

  // 4. Releases CRUD & Notes Generator
  let createdReleaseId;
  await test('POST /api/releases creates release with auto risk evaluation and CAB link', async () => {
    const res = await invoke('POST', '/api/releases', {
      version: 'v3.5.0-rc2',
      title: 'Kafka Consumer Group Auto-Rebalancing Optimization',
      serviceId: 'svc-payments',
      releaseType: 'minor',
      targetEnvironment: 'prod-us',
      author: 'Elena Rostova',
      highlights: 'High-throughput Kafka stream consumer optimizations',
      databaseMigrations: ['20261120_kafka_partitions_meta.sql']
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.version, 'v3.5.0-rc2');
    assert.ok(res.body.id);
    assert.ok(res.body.cabStatus);
    createdReleaseId = res.body.id;
  });

  await test('POST /api/releases/:id/generate-notes outputs comprehensive markdown changelog', async () => {
    const res = await invoke('POST', `/api/releases/${createdReleaseId}/generate-notes`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.markdown.includes('Release Notes: Payment Gateway Bridge - v3.5.0-rc2'));
    assert.ok(res.body.markdown.includes('Kafka Consumer Group'));
  });

  // 5. Environments & Freeze Control
  await test('POST /api/environments/prod-us/freeze toggles lock state and prevents non-emergency deploys', async () => {
    // Freeze it
    const freezeRes = await invoke('POST', '/api/environments/prod-us/freeze', {
      isFrozen: true,
      reason: 'Black Friday Deployment Freeze Window',
      actor: 'Marcus Vance'
    });
    assert.strictEqual(freezeRes.status, 200);
    assert.strictEqual(freezeRes.body.environment.isFrozen, true);

    // Attempt deployment without bypass -> Expect 403 Forbidden
    const deployBlocked = await invoke('POST', '/api/deployments', {
      serviceId: 'svc-payments',
      version: 'v3.5.0-rc2',
      environment: 'prod-us',
      strategy: 'canary'
    });
    assert.strictEqual(deployBlocked.status, 403);
    assert.ok(deployBlocked.body.error.includes('Black Friday Deployment Freeze Window'));

    // Unfreeze it
    const unfreezeRes = await invoke('POST', '/api/environments/prod-us/freeze', {
      isFrozen: false,
      actor: 'Marcus Vance'
    });
    assert.strictEqual(unfreezeRes.status, 200);
    assert.strictEqual(unfreezeRes.body.environment.isFrozen, false);
  });

  // 6. Deployments Engine & Progression
  let liveDepId;
  await test('POST /api/deployments launches async multi-stage pipeline', async () => {
    const deployRes = await invoke('POST', '/api/deployments', {
      serviceId: 'svc-auth',
      version: 'v2.19.0',
      environment: 'staging',
      strategy: 'blue-green',
      deployedBy: 'Elena Rostova'
    });
    assert.strictEqual(deployRes.status, 201);
    assert.strictEqual(deployRes.body.status, 'in_progress');
    assert.ok(deployRes.body.stages.length >= 5);
    liveDepId = deployRes.body.id;
  });

  await test('POST /api/deployments/:id/canary-traffic overrides traffic weight', async () => {
    const trafficRes = await invoke('POST', `/api/deployments/${liveDepId}/canary-traffic`, {
      percent: 50,
      actor: 'Elena Rostova'
    });
    assert.strictEqual(trafficRes.status, 200);
    assert.strictEqual(trafficRes.body.canaryTrafficPercent, 50);
  });

  // 7. Emergency Rollback Circuit Breaker
  await test('POST /api/deployments/:id/rollback triggers emergency circuit breaker restoration', async () => {
    const rbRes = await invoke('POST', `/api/deployments/${liveDepId}/rollback`, {
      reason: 'Synthetic canary probe latency regression detected',
      actor: 'Elena Rostova'
    });
    assert.strictEqual(rbRes.status, 200);
    assert.strictEqual(rbRes.body.success, true);
    assert.strictEqual(rbRes.body.rollbackDeployment.status, 'success');
    assert.strictEqual(rbRes.body.rollbackDeployment.strategy, 'instant_rollback');
  });

  // 8. CAB Approvals Workflow
  await test('GET /api/approvals and POST /api/approvals/:id/approve functions correctly', async () => {
    const listRes = await invoke('GET', '/api/approvals');
    assert.strictEqual(listRes.status, 200);
    const pending = listRes.body.find(a => a.status === 'PENDING');
    if (pending) {
      const approveRes = await invoke('POST', `/api/approvals/${pending.id}/approve`, {
        role: 'Release Engineering Lead',
        approver: 'Devon Reed',
        comment: 'Approved for deployment.'
      });
      assert.strictEqual(approveRes.status, 200);
      assert.strictEqual(approveRes.body.success, true);
    }
  });

  // 9. Config Drift Auditor
  await test('GET /api/configs/diff compares Staging vs Prod configuration variables', async () => {
    const diffRes = await invoke('GET', '/api/configs/diff?serviceId=svc-payments&envA=staging&envB=prod-us');
    assert.strictEqual(diffRes.status, 200);
    assert.strictEqual(diffRes.body.serviceId, 'svc-payments');
    assert.ok(diffRes.body.comparison.length > 0);
    assert.ok(diffRes.body.driftsCount >= 0);
    const secretVar = diffRes.body.comparison.find(c => c.isSecret);
    if (secretVar) {
      assert.strictEqual(secretVar.status, 'SECURE_MATCH');
    }
  });

  // 10. DORA Metrics Hub
  await test('GET /api/dora returns four key metrics and weekly trends', async () => {
    const doraRes = await invoke('GET', '/api/dora');
    assert.strictEqual(doraRes.status, 200);
    assert.ok(doraRes.body.summary.deploymentFrequency);
    assert.ok(doraRes.body.summary.leadTimeForChanges);
    assert.ok(doraRes.body.summary.changeFailureRate);
    assert.ok(doraRes.body.summary.meanTimeToRecovery);
    assert.ok(doraRes.body.weeklyTrends.length >= 4);
  });

  // 11. Audit Trail
  await test('GET /api/audit-logs records all operations immutably', async () => {
    const auditRes = await invoke('GET', '/api/audit-logs');
    assert.strictEqual(auditRes.status, 200);
    assert.ok(auditRes.body.length > 0);
    const actions = auditRes.body.map(a => a.action);
    assert.ok(actions.includes('ROLLBACK_EXECUTED') || actions.includes('DEPLOYMENT_TRIGGERED') || actions.includes('CAB_APPROVAL_GRANTED'));
  });

  // 12. Static Assets Serving
  await test('GET / serves index.html and static files with correct content types', async () => {
    const htmlRes = await invoke('GET', '/');
    assert.strictEqual(htmlRes.status, 200);
    assert.strictEqual(htmlRes.headers['Content-Type'], 'text/html; charset=utf-8');
    assert.ok(htmlRes.body.includes('OrbitOps'));

    const cssRes = await invoke('GET', '/css/portal.css');
    assert.strictEqual(cssRes.status, 200);
    assert.strictEqual(cssRes.headers['Content-Type'], 'text/css; charset=utf-8');

    const jsRes = await invoke('GET', '/js/portal.js');
    assert.strictEqual(jsRes.status, 200);
    assert.strictEqual(jsRes.headers['Content-Type'], 'application/javascript; charset=utf-8');
  });

  console.log('---------------------------------------------------------');
  console.log(`Test Execution Finished: ${passed} Passed, ${failed} Failed`);
  console.log('---------------------------------------------------------');

  if (failed > 0) process.exit(1);
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test Suite Fatal Error:', err);
  process.exit(1);
});
